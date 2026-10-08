import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { appDb, closeDb, truncateAll } from '../../support/db';
import { assertLedgerInvariant } from '../../support/invariants';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import {
  ledgerRows,
  type OpenedWallet,
  openWallet,
  operation,
  outboxFor,
  submit,
  type TransactionInput,
  walletBalance,
} from '../../support/wagering-http';

let running: RunningTestApp;
let wallet: OpenedWallet;

beforeAll(async () => {
  running = await startTestApp({ INSTANCE_ID: 'it-reversal-rules' });
});

afterAll(async () => {
  await running.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
  wallet = await openWallet(running.baseUrl, '100.00');
});

/** Envia e exige o status; devolve o corpo. */
async function expectSubmit(input: TransactionInput, status: number, key?: string) {
  const response = await submit(running.baseUrl, input, key);
  expect(response.status, `${input.kind} → ${JSON.stringify(response.body)}`).toBe(status);
  return response.body;
}

function reversalOf(
  reference: TransactionInput,
  kind: 'REFUND' | 'ROLLBACK',
  overrides: Partial<TransactionInput> = {},
) {
  return operation(wallet, {
    kind,
    roundId: reference.roundId,
    money: reference.money,
    referenceExternalTransactionId: reference.externalTransactionId,
    ...overrides,
  });
}

async function referenceIdOf(transactionId: string): Promise<string | null> {
  const [row] = await appDb()`select reference_transaction_id from wager_transactions where id = ${transactionId}`;
  return (row as { reference_transaction_id: string | null }).reference_transaction_id;
}

describe('REFUND and ROLLBACK — reversal once', () => {
  it('REFUND credits the BET back and stores the reference; a second REFUND or a ROLLBACK is ALREADY_REVERSED', async () => {
    const bet = operation(wallet);
    const betBody = await expectSubmit(bet, 201);
    const refund = await expectSubmit(reversalOf(bet, 'REFUND'), 201);

    expect(refund.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(await referenceIdOf(refund.transactionId)).toBe(betBody.transactionId);
    expect((await outboxFor(refund.transactionId)).map((event) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    const secondRefund = await expectSubmit(reversalOf(bet, 'REFUND'), 422);
    expect(secondRefund).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    const rollback = await expectSubmit(reversalOf(bet, 'ROLLBACK'), 422);
    expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });

    expect(await walletBalance(wallet.walletId)).toBe('100.00');
    expect((await ledgerRows(wallet.walletId)).map((row) => row.direction)).toEqual(['DEBIT', 'CREDIT']);
    await assertLedgerInvariant([wallet.walletId], { baseUrl: running.baseUrl });
  });

  it('a WIN that references an already refunded BET is ALREADY_REVERSED', async () => {
    const bet = operation(wallet);
    await expectSubmit(bet, 201);
    await expectSubmit(reversalOf(bet, 'REFUND'), 201);
    const win = await expectSubmit(
      operation(wallet, { kind: 'WIN', referenceExternalTransactionId: bet.externalTransactionId }),
      422,
    );
    expect(win.failureCode).toBe('ALREADY_REVERSED');
  });
});

describe('ROLLBACK — inverse of the reference', () => {
  it('ROLLBACK of a BET credits it back', async () => {
    const bet = operation(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    await expectSubmit(bet, 201);
    const body = await expectSubmit(reversalOf(bet, 'ROLLBACK'), 201);
    expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect((await ledgerRows(wallet.walletId)).map((row) => row.direction)).toEqual(['DEBIT', 'CREDIT']);
  });

  it('ROLLBACK of a WIN debits it', async () => {
    const win = operation(wallet, { kind: 'WIN', money: { amount: '40.00', currency: 'BRL' } });
    await expectSubmit(win, 201);
    const body = await expectSubmit(reversalOf(win, 'ROLLBACK'), 201);
    expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect((await ledgerRows(wallet.walletId)).map((row) => row.direction)).toEqual(['CREDIT', 'DEBIT']);
  });

  it('ROLLBACK of a REFUND debits it (and the BET stays refunded)', async () => {
    const bet = operation(wallet, { money: { amount: '10.00', currency: 'BRL' } });
    await expectSubmit(bet, 201);
    const refund = reversalOf(bet, 'REFUND');
    await expectSubmit(refund, 201);
    const body = await expectSubmit(reversalOf(refund, 'ROLLBACK'), 201);
    expect(body.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect((await ledgerRows(wallet.walletId)).map((row) => row.direction)).toEqual(['DEBIT', 'CREDIT', 'DEBIT']);
    await assertLedgerInvariant([wallet.walletId]);
  });

  it('ROLLBACK of a LOSS and REFUND of a WIN are REFERENCE_KIND_NOT_ALLOWED', async () => {
    const loss = operation(wallet, { kind: 'LOSS', money: { amount: '5.00', currency: 'BRL' } });
    await expectSubmit(loss, 201);
    expect((await expectSubmit(reversalOf(loss, 'ROLLBACK'), 422)).failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');

    const win = operation(wallet, { kind: 'WIN', money: { amount: '5.00', currency: 'BRL' } });
    await expectSubmit(win, 201);
    expect((await expectSubmit(reversalOf(win, 'REFUND'), 422)).failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
  });

  it('ROLLBACK of a WIN without funds is REVERSAL_INSUFFICIENT_FUNDS (not INSUFFICIENT_FUNDS) and auditable', async () => {
    const win = operation(wallet, { kind: 'WIN', money: { amount: '50.00', currency: 'BRL' } });
    await expectSubmit(win, 201);
    await expectSubmit(operation(wallet, { money: { amount: '140.00', currency: 'BRL' } }), 201);

    const body = await expectSubmit(reversalOf(win, 'ROLLBACK'), 422);

    expect(body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
    });
    const [row] = await appDb()`
      select status, failure_code, reference_transaction_id from wager_transactions where id = ${body.transactionId}`;
    expect(row).toEqual({
      status: 'REJECTED',
      failure_code: 'REVERSAL_INSUFFICIENT_FUNDS',
      reference_transaction_id: null,
    });
    expect((await outboxFor(body.transactionId)).map((event) => event.event_type)).toEqual([
      'WagerTransactionRejected',
    ]);
    expect(await walletBalance(wallet.walletId)).toBe('10.00');
    await assertLedgerInvariant([wallet.walletId]);
  });
});

describe('reference validation', () => {
  it('a reference from another round is REFERENCE_MISMATCH; another amount is REFERENCE_AMOUNT_MISMATCH', async () => {
    const bet = operation(wallet);
    await expectSubmit(bet, 201);
    expect((await expectSubmit(reversalOf(bet, 'REFUND', { roundId: 'round-2' }), 422)).failureCode).toBe(
      'REFERENCE_MISMATCH',
    );
    expect(
      (await expectSubmit(reversalOf(bet, 'REFUND', { money: { amount: '24.99', currency: 'BRL' } }), 422)).failureCode,
    ).toBe('REFERENCE_AMOUNT_MISMATCH');
  });

  it('a reference of another player and wallet is REFERENCE_MISMATCH', async () => {
    const bet = operation(wallet);
    await expectSubmit(bet, 201);
    const other = await openWallet(running.baseUrl, '100.00');
    const refund = operation(other, {
      kind: 'REFUND',
      money: bet.money,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await expectSubmit(refund, 422)).failureCode).toBe('REFERENCE_MISMATCH');
  });

  it('a reference in another wallet and currency of the same player is REFERENCE_MISMATCH', async () => {
    const bet = operation(wallet);
    await expectSubmit(bet, 201);
    const usdWallet = await openWallet(running.baseUrl, '100.00', 'USD', wallet.playerId);
    const refund = operation(usdWallet, {
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'USD' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await expectSubmit(refund, 422)).failureCode).toBe('REFERENCE_MISMATCH');
  });

  it('a REJECTED reference is REFERENCE_NOT_PROCESSED', async () => {
    const bet = operation(wallet, { money: { amount: '500.00', currency: 'BRL' } });
    await expectSubmit(bet, 422);
    expect((await expectSubmit(reversalOf(bet, 'REFUND'), 422)).failureCode).toBe('REFERENCE_NOT_PROCESSED');
  });

  it('a reference of another provider is never found (lookup is per provider) → PENDING_REFERENCE', async () => {
    const bet = operation(wallet);
    await expectSubmit(bet, 201);
    const body = await expectSubmit(reversalOf(bet, 'REFUND', { providerId: 'provider-b' }), 202);
    expect(body).toEqual({ transactionId: expect.any(String), status: 'PENDING_REFERENCE', idempotentReplay: false });
  });
});
