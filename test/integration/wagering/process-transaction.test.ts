import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { OUTBOX_REPOSITORY, type OutboxRepository } from '@/messaging/outbox/application/outbox.repository.port';
import { UnitOfWork } from '@/shared/persistence/unit-of-work';
import { appDb, closeDb, truncateAll } from '../../support/db';
import { assertLedgerInvariant } from '../../support/invariants';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import {
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
  running = await startTestApp({ INSTANCE_ID: 'it-wagering-process' });
});

afterAll(async () => {
  await running.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
  wallet = await openWallet(running.baseUrl, '1000.00');
});

async function transactionRow(id: string) {
  const [row] = await appDb()`
    select status, failure_code, kind, amount::text, currency, balance_after_amount::text,
           balance_after_currency, reference_transaction_id, correlation_id, processed_at is not null as processed
      from wager_transactions where id = ${id}`;
  return row as Record<string, unknown>;
}

describe('POST /wagering/transactions — BET, WIN, LOSS', () => {
  it('processes a BET: 201, balance 975.00, one DEBIT, Processed + BalanceChanged in the outbox', async () => {
    const bet = operation(wallet);
    const response = await submit(running.baseUrl, bet, undefined, { 'x-correlation-id': 'corr-bet-1' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const id = response.body.transactionId;
    expect(await walletBalance(wallet.walletId)).toBe('975.00');
    expect(await ledgerRows(wallet.walletId)).toEqual([
      {
        transaction_id: id,
        direction: 'DEBIT',
        amount: '25.00',
        balance_before: '1000.00',
        balance_after: '975.00',
        wallet_version: 2,
      },
    ]);
    expect(await transactionRow(id)).toMatchObject({
      status: 'PROCESSED',
      failure_code: null,
      balance_after_amount: '975.00',
      balance_after_currency: 'BRL',
      correlation_id: 'corr-bet-1',
      processed: true,
    });

    const events = await outboxFor(id);
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    for (const event of events) {
      expect(event.correlation_id).toBe('corr-bet-1');
      expect(event.payload).toMatchObject({
        aggregateId: wallet.walletId,
        correlationId: 'corr-bet-1',
        causationId: id,
      });
    }
    expect(events[0]?.payload.data).toMatchObject({
      transactionId: id,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
      balanceAfter: { amount: '975.00', currency: 'BRL' },
    });
    expect(events[1]?.payload.data).toEqual({
      walletId: wallet.walletId,
      transactionId: id,
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '1000.00', currency: 'BRL' },
      balanceAfter: { amount: '975.00', currency: 'BRL' },
      walletVersion: 2,
    });
    await assertLedgerInvariant([wallet.walletId], { baseUrl: running.baseUrl });
  });

  it('rejects a BET without funds: 422 INSUFFICIENT_FUNDS, REJECTED persisted, no entry, Rejected event only', async () => {
    const bet = operation(wallet, { money: { amount: '1000.01', currency: 'BRL' } });
    const response = await submit(running.baseUrl, bet);

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '1000.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const id = response.body.transactionId;
    expect(await transactionRow(id)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
      balance_after_amount: '1000.00',
      balance_after_currency: 'BRL',
      processed: true,
    });
    expect(await ledgerRows(wallet.walletId)).toEqual([]);
    expect(await walletBalance(wallet.walletId)).toBe('1000.00');
    const events = await outboxFor(id);
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionRejected']);
    expect(events[0]?.payload.data).toMatchObject({
      failureCode: 'INSUFFICIENT_FUNDS',
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
    });
    await assertLedgerInvariant([wallet.walletId]);
  });

  it('debits the whole balance down to exactly zero', async () => {
    const response = await submit(
      running.baseUrl,
      operation(wallet, { money: { amount: '1000.00', currency: 'BRL' } }),
    );
    expect(response.status).toBe(201);
    expect(response.body.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    await assertLedgerInvariant([wallet.walletId]);
  });

  it('credits a WIN: 201, one CREDIT, Processed + BalanceChanged', async () => {
    const response = await submit(
      running.baseUrl,
      operation(wallet, { kind: 'WIN', money: { amount: '50.10', currency: 'BRL' } }),
    );

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '1050.10', currency: 'BRL' } });
    const id = response.body.transactionId;
    expect(await ledgerRows(wallet.walletId)).toEqual([
      {
        transaction_id: id,
        direction: 'CREDIT',
        amount: '50.10',
        balance_before: '1000.00',
        balance_after: '1050.10',
        wallet_version: 2,
      },
    ]);
    expect((await outboxFor(id)).map((event) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await assertLedgerInvariant([wallet.walletId]);
  });

  it('records a LOSS: 201 PROCESSED, no entry, Processed event and no BalanceChanged (0.00 accepted)', async () => {
    for (const amount of ['25.00', '0.00']) {
      const response = await submit(
        running.baseUrl,
        operation(wallet, { kind: 'LOSS', money: { amount, currency: 'BRL' } }),
      );
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '1000.00', currency: 'BRL' } });
      expect((await outboxFor(response.body.transactionId)).map((event) => event.event_type)).toEqual([
        'WagerTransactionProcessed',
      ]);
    }
    expect(await ledgerRows(wallet.walletId)).toEqual([]);
    expect(await walletBalance(wallet.walletId)).toBe('1000.00');
    await assertLedgerInvariant([wallet.walletId]);
  });

  it('processes a WIN that references the BET of the same round and stores the internal reference id', async () => {
    const bet = operation(wallet);
    const betResponse = await submit(running.baseUrl, bet);
    const win = operation(wallet, {
      kind: 'WIN',
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const response = await submit(running.baseUrl, win);

    expect(response.status).toBe(201);
    expect(response.body.balance).toEqual({ amount: '1015.00', currency: 'BRL' });
    expect(await transactionRow(response.body.transactionId)).toMatchObject({
      reference_transaction_id: betResponse.body.transactionId,
    });
  });

  it('rejects a currency mismatch (USD on a BRL wallet) with 422 CURRENCY_MISMATCH and a BRL snapshot', async () => {
    const response = await submit(running.baseUrl, operation(wallet, { money: { amount: '25.00', currency: 'USD' } }));

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'CURRENCY_MISMATCH',
      balance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(await transactionRow(response.body.transactionId)).toMatchObject({
      currency: 'USD',
      balance_after_currency: 'BRL',
    });
    expect(await ledgerRows(wallet.walletId)).toEqual([]);
  });

  it('rejects a player that does not own the wallet with 422 WALLET_PLAYER_MISMATCH', async () => {
    const response = await submit(running.baseUrl, operation(wallet, { playerId: 'someone-else' }));

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_PLAYER_MISMATCH' });
    expect(await walletBalance(wallet.walletId)).toBe('1000.00');
  });

  it('answers 404 WALLET_NOT_FOUND for an unknown wallet and persists nothing', async () => {
    const before = await appDb()`select count(*)::int as n from wager_transactions`;
    const response = await submit(running.baseUrl, operation({ ...wallet, walletId: crypto.randomUUID() }));

    expectErrorCode(response, 404, 'WALLET_NOT_FOUND');
    const after = await appDb()`select count(*)::int as n from wager_transactions`;
    expect(after).toEqual(before);
  });

  it('is atomic: a failure inserting the outbox rolls back the transaction, the balance and the ledger', async () => {
    const outbox = running.app.get<OutboxRepository>(OUTBOX_REPOSITORY);
    const uow = running.app.get(UnitOfWork);
    const spy = spyOn(outbox, 'enqueue').mockImplementationOnce(async () => {
      await uow.em.execute('insert into outbox_messages (id) values (null)');
    });
    const bet = operation(wallet);
    try {
      const failed = await submit(running.baseUrl, bet);
      expectErrorCode(failed, 500, 'INTERNAL_ERROR');
    } finally {
      spy.mockRestore();
    }

    expect(await walletBalance(wallet.walletId)).toBe('1000.00');
    expect(await ledgerRows(wallet.walletId)).toEqual([]);
    const rows = await appDb()`select count(*)::int as n from wager_transactions where kind = 'BET'`;
    expect(rows).toEqual([{ n: 0 }]);
    const events = await appDb()`
      select count(*)::int as n from outbox_messages where payload->'data'->>'kind' = 'BET'
          or (event_type = 'WalletBalanceChanged' and payload->'data'->>'direction' = 'DEBIT')`;
    expect(events).toEqual([{ n: 0 }]);

    // A mesma requisição, sem a falha, passa: nada ficou "meio gravado" com a key.
    const retried = await submit(running.baseUrl, bet);
    expect(retried.status).toBe(201);
    expect(retried.body.idempotentReplay).toBe(false);
    await assertLedgerInvariant([wallet.walletId]);
  });
});
