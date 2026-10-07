import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { OUTBOX_REPOSITORY, type OutboxRepository } from '@/messaging/outbox/application/outbox.repository.port';
import { UnitOfWork } from '@/shared/persistence/unit-of-work';
import { appDb, closeDb, truncateAll } from '../../support/db';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import { createWallet, expectError, postJson, tableCounts } from './wallet-test-kit';

let running: RunningTestApp;

beforeAll(async () => {
  running = await startTestApp({ INSTANCE_ID: 'it-wallet-create' });
});

afterAll(async () => {
  await running.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('POST /wallets', () => {
  it('opens a wallet with 1000.00: version 1, OPENING PROCESSED, one CREDIT and two outbox events', async () => {
    const response = await createWallet(running.baseUrl, {
      playerId: 'player-1',
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      playerId: 'player-1',
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const walletId = response.body.id;
    const db = appDb();

    const [wallet] = await db`select balance::text, currency, version::int from wallets where id = ${walletId}`;
    expect(wallet).toEqual({ balance: '1000.00', currency: 'BRL', version: 1 });

    const transactions = await db`
      select id, provider_id, external_transaction_id, idempotency_key, kind, status, amount::text, currency,
             balance_after_amount::text, balance_after_currency, xmin::text as xmin
        from wager_transactions where wallet_id = ${walletId}`;
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      provider_id: 'internal',
      external_transaction_id: `opening:${walletId}`,
      idempotency_key: `opening:${walletId}`,
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '1000.00',
      currency: 'BRL',
      balance_after_amount: '1000.00',
      balance_after_currency: 'BRL',
    });
    const opening = transactions[0] as { id: string; xmin: string };

    const entries = await db`
      select transaction_id, direction, amount::text, balance_before::text, balance_after::text,
             wallet_version::int, xmin::text as xmin
        from wallet_ledger_entries where wallet_id = ${walletId}`;
    expect(entries).toEqual([
      {
        transaction_id: opening.id,
        direction: 'CREDIT',
        amount: '1000.00',
        balance_before: '0.00',
        balance_after: '1000.00',
        wallet_version: 1,
        xmin: opening.xmin,
      },
    ]);

    const outbox = await db`
      select aggregate_id, event_type, event_version, payload, correlation_id, published_at, xmin::text as xmin
        from outbox_messages order by event_type`;
    expect(outbox.map((row: { event_type: string }) => row.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const [processed, balanceChanged] = outbox as {
      aggregate_id: string;
      payload: { data: Record<string, unknown>; correlationId: string };
      correlation_id: string;
      published_at: Date | null;
      xmin: string;
    }[];
    for (const row of [processed, balanceChanged]) {
      expect(row?.aggregate_id).toBe(walletId);
      expect(row?.published_at).toBeNull();
      // Mesma transação SQL: todas as linhas foram gravadas pelo mesmo xid.
      expect(row?.xmin).toBe(opening.xmin);
      expect(row?.correlation_id).toBe(row?.payload.correlationId);
    }
    expect(processed?.payload.data).toMatchObject({
      transactionId: opening.id,
      walletId,
      kind: 'OPENING',
      status: 'PROCESSED',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
    });
    expect(balanceChanged?.payload.data).toEqual({
      walletId,
      transactionId: opening.id,
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  it('uses the request correlation id on the OPENING transaction and the events', async () => {
    const response = await postJson<{ id: string }>(
      running.baseUrl,
      '/wallets',
      { playerId: 'player-corr', initialBalance: { amount: '5.00', currency: 'BRL' } },
      { 'x-correlation-id': 'corr-wallet-1' },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('x-correlation-id')).toBe('corr-wallet-1');
    const [tx] = await appDb()`select correlation_id from wager_transactions where wallet_id = ${response.body.id}`;
    expect(tx).toEqual({ correlation_id: 'corr-wallet-1' });
    const outbox = await appDb()`select distinct correlation_id from outbox_messages`;
    expect(outbox).toEqual([{ correlation_id: 'corr-wallet-1' }]);
  });

  it('opens a wallet with 0.00 without ledger entry, OPENING transaction or event', async () => {
    const response = await createWallet(running.baseUrl, {
      playerId: 'player-zero',
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ balance: { amount: '0.00', currency: 'BRL' }, version: 1 });
    expect(await tableCounts()).toEqual({ wallets: 1, transactions: 0, ledger: 0, outbox: 0 });
  });

  it('opens a wallet with 0.00 in the given currency when initialBalance is omitted', async () => {
    const response = await createWallet(running.baseUrl, { playerId: 'player-usd', currency: 'USD' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ playerId: 'player-usd', balance: { amount: '0.00', currency: 'USD' } });
    expect(await tableCounts()).toEqual({ wallets: 1, transactions: 0, ledger: 0, outbox: 0 });
  });

  it('accepts currency together with initialBalance when they match', async () => {
    const response = await createWallet(running.baseUrl, {
      playerId: 'player-both',
      currency: 'BRL',
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    expect(response.status).toBe(201);
  });

  it('allows the same player in another currency', async () => {
    const brl = await createWallet(running.baseUrl, {
      playerId: 'p',
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    const usd = await createWallet(running.baseUrl, {
      playerId: 'p',
      initialBalance: { amount: '1.00', currency: 'USD' },
    });
    expect([brl.status, usd.status]).toEqual([201, 201]);
  });

  it('rejects a duplicated wallet (same player and currency) with 409 WALLET_ALREADY_EXISTS and persists nothing new', async () => {
    const body = { playerId: 'player-dup', initialBalance: { amount: '10.00', currency: 'BRL' } };
    expect((await createWallet(running.baseUrl, body)).status).toBe(201);
    const before = await tableCounts();

    expectError(await createWallet(running.baseUrl, body), 409, 'WALLET_ALREADY_EXISTS');
    expectError(
      await createWallet(running.baseUrl, { playerId: 'player-dup', currency: 'BRL' }),
      409,
      'WALLET_ALREADY_EXISTS',
    );
    expect(await tableCounts()).toEqual(before);
  });

  it('rolls everything back when the outbox insert fails inside the transaction', async () => {
    const outbox = running.app.get<OutboxRepository>(OUTBOX_REPOSITORY);
    const uow = running.app.get(UnitOfWork);
    // Fault hook de teste: a escrita da outbox executa um INSERT inválido de verdade, na mesma transação SQL,
    // depois de wallet, OPENING e lançamento já terem sido inseridos.
    const fault = spyOn(outbox, 'enqueue').mockImplementationOnce(async () => {
      await uow.em.execute('insert into outbox_messages (id) values (null)');
    });
    try {
      const response = await createWallet(running.baseUrl, {
        playerId: 'player-fault',
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      });
      expectError(response, 500, 'INTERNAL_ERROR');
      expect(fault).toHaveBeenCalledTimes(1);
    } finally {
      fault.mockRestore();
    }
    expect(await tableCounts()).toEqual({ wallets: 0, transactions: 0, ledger: 0, outbox: 0 });

    // Sem a falha, a mesma requisição passa (nada ficou "meio criado").
    const retry = await createWallet(running.baseUrl, {
      playerId: 'player-fault',
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(retry.status).toBe(201);
    expect(await tableCounts()).toEqual({ wallets: 1, transactions: 1, ledger: 1, outbox: 2 });
  });

  describe('invalid payloads → 400 VALIDATION_ERROR', () => {
    const cases: readonly [string, unknown, string][] = [
      [
        'amount as a JS number',
        { playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } },
        'initialBalance.amount',
      ],
      [
        'amount with one decimal place',
        { playerId: 'p', initialBalance: { amount: '10.5', currency: 'BRL' } },
        'initialBalance.amount',
      ],
      [
        'amount without decimals',
        { playerId: 'p', initialBalance: { amount: '10', currency: 'BRL' } },
        'initialBalance.amount',
      ],
      [
        'negative amount',
        { playerId: 'p', initialBalance: { amount: '-1.00', currency: 'BRL' } },
        'initialBalance.amount',
      ],
      [
        'scientific notation',
        { playerId: 'p', initialBalance: { amount: '1e3', currency: 'BRL' } },
        'initialBalance.amount',
      ],
      [
        'lowercase currency',
        { playerId: 'p', initialBalance: { amount: '10.00', currency: 'brl' } },
        'initialBalance.currency',
      ],
      [
        'currency with 4 letters',
        { playerId: 'p', initialBalance: { amount: '10.00', currency: 'REAL' } },
        'initialBalance.currency',
      ],
      ['empty playerId', { playerId: '', initialBalance: { amount: '10.00', currency: 'BRL' } }, 'playerId'],
      ['blank playerId', { playerId: '   ', initialBalance: { amount: '10.00', currency: 'BRL' } }, 'playerId'],
      ['missing playerId', { initialBalance: { amount: '10.00', currency: 'BRL' } }, 'playerId'],
      ['numeric playerId', { playerId: 42, initialBalance: { amount: '10.00', currency: 'BRL' } }, 'playerId'],
      ['no initialBalance and no currency', { playerId: 'p' }, 'currency'],
      [
        'currency different from initialBalance',
        { playerId: 'p', currency: 'USD', initialBalance: { amount: '1.00', currency: 'BRL' } },
        'currency',
      ],
      ['unknown field', { playerId: 'p', currency: 'BRL', extra: true }, '(root)'],
      [
        'unknown money field',
        { playerId: 'p', initialBalance: { amount: '1.00', currency: 'BRL', cents: 100 } },
        'initialBalance',
      ],
    ];

    for (const [name, body, path] of cases) {
      it(`rejects ${name}`, async () => {
        const error = expectError(await createWallet(running.baseUrl, body), 400, 'VALIDATION_ERROR');
        expect(error.error.details?.map((detail) => detail.path)).toContain(path);
        expect(await tableCounts()).toEqual({ wallets: 0, transactions: 0, ledger: 0, outbox: 0 });
      });
    }

    it('rejects malformed JSON without echoing it', async () => {
      const error = expectError(
        await postJson(running.baseUrl, '/wallets', '{"playerId": "p",'),
        400,
        'VALIDATION_ERROR',
      );
      expect(error.error.message).toBe('Malformed request');
    });

    it('rejects a request without body', async () => {
      expectError(await postJson(running.baseUrl, '/wallets'), 400, 'VALIDATION_ERROR');
    });

    it('never echoes the received amount in the error', async () => {
      const response = await createWallet(running.baseUrl, {
        playerId: 'p',
        initialBalance: { amount: '98765.4321', currency: 'BRL' },
      });
      expectError(response, 400, 'VALIDATION_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('98765');
    });
  });
});
