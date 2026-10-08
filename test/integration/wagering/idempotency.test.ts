import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { appDb, closeDb, truncateAll } from '../../support/db';
import { assertLedgerInvariant } from '../../support/invariants';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import {
  defaultKey,
  expectErrorCode,
  ledgerRows,
  type OpenedWallet,
  openWallet,
  operation,
  outboxFor,
  submit,
  walletBalance,
} from '../../support/wagering-http';

let running: RunningTestApp;
let wallet: OpenedWallet;

beforeAll(async () => {
  running = await startTestApp({ INSTANCE_ID: 'it-wagering-idempotency' });
});

afterAll(async () => {
  await running.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
  wallet = await openWallet(running.baseUrl, '1000.00');
});

describe('POST /wagering/transactions — idempotency', () => {
  it('replays an identical request with 200, idempotentReplay and the balance observed the first time', async () => {
    const bet = operation(wallet);
    const first = await submit(running.baseUrl, bet);
    expect(first.status).toBe(201);

    // Outras operações mudam o saldo depois da primeira resposta.
    await submit(running.baseUrl, operation(wallet, { kind: 'WIN', money: { amount: '500.00', currency: 'BRL' } }));
    await submit(running.baseUrl, operation(wallet, { money: { amount: '100.00', currency: 'BRL' } }));
    expect(await walletBalance(wallet.walletId)).toBe('1375.00');

    const replay = await submit(running.baseUrl, bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual({ amount: '975.00', currency: 'BRL' });

    // O replay não toca na wallet, no ledger nem na outbox.
    expect(await walletBalance(wallet.walletId)).toBe('1375.00');
    expect(
      (await ledgerRows(wallet.walletId)).filter((row) => row.transaction_id === first.body.transactionId),
    ).toHaveLength(1);
    expect(await outboxFor(first.body.transactionId)).toHaveLength(2);
    await assertLedgerInvariant([wallet.walletId]);
  });

  it('replays a REJECTED transaction with 422 and idempotentReplay', async () => {
    const bet = operation(wallet, { money: { amount: '5000.00', currency: 'BRL' } });
    const first = await submit(running.baseUrl, bet);
    expect(first.status).toBe(422);

    await submit(running.baseUrl, operation(wallet, { kind: 'WIN', money: { amount: '9000.00', currency: 'BRL' } }));
    const replay = await submit(running.baseUrl, bet);

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '1000.00' } });
    expect(await outboxFor(first.body.transactionId)).toHaveLength(1);
  });

  it('replays a LOSS with 200', async () => {
    const loss = operation(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } });
    expect((await submit(running.baseUrl, loss)).status).toBe(201);
    const replay = await submit(running.baseUrl, loss);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  it('answers 409 IDEMPOTENCY_CONFLICT for the same key with a different payload, persisting nothing', async () => {
    const bet = operation(wallet);
    const key = defaultKey(bet);
    const first = await submit(running.baseUrl, bet, key);
    expect(first.status).toBe(201);

    const variants = [
      { ...bet, money: { amount: '26.00', currency: 'BRL' } },
      { ...bet, roundId: 'round-2' },
      { ...bet, externalTransactionId: 'other-external-id' },
      { ...bet, kind: 'WIN' },
    ];
    for (const variant of variants) {
      expectErrorCode(await submit(running.baseUrl, variant, key), 409, 'IDEMPOTENCY_CONFLICT');
    }
    expect(await walletBalance(wallet.walletId)).toBe('975.00');
    const [row] = await appDb()`select count(*)::int as n from wager_transactions where kind <> 'OPENING'`;
    expect(row).toEqual({ n: 1 });
  });

  it('answers 409 EXTERNAL_ID_CONFLICT for another key reusing the externalTransactionId with a different payload', async () => {
    const bet = operation(wallet);
    expect((await submit(running.baseUrl, bet, 'key-1')).status).toBe(201);

    const conflict = await submit(running.baseUrl, { ...bet, money: { amount: '30.00', currency: 'BRL' } }, 'key-2');
    expectErrorCode(conflict, 409, 'EXTERNAL_ID_CONFLICT');
    expect(await walletBalance(wallet.walletId)).toBe('975.00');
  });

  it('treats another key with the same externalTransactionId and identical payload as a replay (same operation)', async () => {
    const bet = operation(wallet);
    const first = await submit(running.baseUrl, bet, 'key-1');
    const replay = await submit(running.baseUrl, bet, 'key-2');

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await walletBalance(wallet.walletId)).toBe('975.00');
  });

  it('accepts the same externalTransactionId from another provider as a new operation', async () => {
    const bet = operation(wallet);
    expect((await submit(running.baseUrl, bet)).status).toBe(201);
    const other = await submit(running.baseUrl, { ...bet, providerId: 'provider-b' });
    expect(other.status).toBe(201);
    expect(await walletBalance(wallet.walletId)).toBe('950.00');
  });

  it('ignores transport metadata (correlation id) in the hash: a replay with another correlation id is still a replay', async () => {
    const bet = operation(wallet);
    await submit(running.baseUrl, bet, undefined, { 'x-correlation-id': 'first' });
    const replay = await submit(running.baseUrl, bet, undefined, { 'x-correlation-id': 'second' });
    expect(replay.status).toBe(200);
  });
});
