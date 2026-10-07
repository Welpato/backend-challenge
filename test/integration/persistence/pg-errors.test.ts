import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { UnitOfWorkScopeError } from '@/shared/persistence/persistence.errors';
import { CheckViolationError, TransientDatabaseError, UniqueViolationError } from '@/shared/persistence/pg-errors';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { Wallet } from '@/wallet/domain/wallet';
import { appDb, closeDb, truncateAll } from '../../support/db';
import { captureError, latch, openPersistence, type Persistence } from '../../support/persistence';
import { AT, betFor, brl, persistOpenedWallet } from './persistence-fixtures';

let db: Persistence;

beforeAll(async () => {
  db = await openPersistence();
});

afterAll(async () => {
  await db.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('UnitOfWork error classification (real PostgreSQL errors)', () => {
  it('classifies a duplicate wallet as a unique violation with the constraint name', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('0.00'));
    const duplicate = Wallet.open({
      id: crypto.randomUUID(),
      playerId: wallet.playerId,
      initialBalance: brl('0.00'),
      at: AT,
    });
    const error = await captureError(db.uow.run(() => db.wallets.insert(duplicate.wallet)));
    expect(error).toBeInstanceOf(UniqueViolationError);
    expect(error).toMatchObject({ constraint: 'uq_wallets_player_currency' });
  });

  it('classifies a second processed reversal of the same reference as ux_reversal_once', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const bet = betFor(wallet);
    const refund = betFor(wallet, {
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const rollback = betFor(wallet, {
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    bet.markProcessed(undefined, brl('100.00'), AT);
    refund.markProcessed(bet.id, brl('100.00'), AT);
    rollback.markProcessed(bet.id, brl('100.00'), AT);
    await db.uow.run(async () => {
      await db.transactions.insertIfAbsent(bet);
      await db.transactions.insertIfAbsent(refund);
    });
    expect(await db.uow.run(() => db.transactions.hasProcessedReversal(bet.id))).toBe(true);

    const pending = betFor(wallet, {
      kind: WagerTransactionKind.Rollback,
      externalTransactionId: rollback.externalTransactionId,
      idempotencyKey: rollback.idempotencyKey,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await db.uow.run(() => db.transactions.insertIfAbsent(pending));
    pending.markProcessed(bet.id, brl('100.00'), AT);
    const error = await captureError(db.uow.run(() => db.transactions.save(pending)));
    expect(error).toBeInstanceOf(UniqueViolationError);
    expect(error).toMatchObject({ constraint: 'ux_reversal_once' });
  });

  it('reports no processed reversal for an unreversed or only rejected reversal', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const bet = betFor(wallet);
    bet.markProcessed(undefined, brl('100.00'), AT);
    const rejected = betFor(wallet, {
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    rejected.reject('REFERENCE_AMOUNT_MISMATCH', brl('100.00'), AT);
    await db.uow.run(async () => {
      await db.transactions.insertIfAbsent(bet);
      await db.transactions.insertIfAbsent(rejected);
    });
    expect(await db.uow.run(() => db.transactions.hasProcessedReversal(bet.id))).toBe(false);
  });

  it('classifies a CHECK violation with the constraint name', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('0.00'));
    const error = await captureError(
      db.uow.run((em) => em.execute("update wallets set currency = 'brl' where id = ?", [wallet.id])),
    );
    expect(error).toBeInstanceOf(CheckViolationError);
    expect(error).toMatchObject({ constraint: 'wallets_currency_check' });
  });

  it('classifies the deferred wallet ↔ ledger consistency failure raised at COMMIT', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const error = await captureError(
      db.uow.run(async () => {
        const current = await db.wallets.findByIdForUpdate(wallet.id);
        if (current === undefined) {
          throw new Error('wallet not found');
        }
        current.credit(crypto.randomUUID(), brl('5.00'), AT);
        await db.wallets.updateBalance(current, 1); // sem lançamento no ledger
      }),
    );
    expect(error).toBeInstanceOf(CheckViolationError);
    expect(error).toMatchObject({ constraint: 'trg_wallet_ledger_consistency' });
    expect((await db.uow.run(() => db.wallets.findById(wallet.id)))?.version).toBe(1);
  });

  it('classifies a lock timeout as transient', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('0.00'));
    const locked = latch();
    const release = latch();
    const holder = db.uow.run(async () => {
      await db.wallets.findByIdForUpdate(wallet.id);
      locked.open();
      await release.promise;
    });
    await locked.promise;
    const error = await captureError(db.uow.run(() => db.wallets.findByIdForUpdate(wallet.id), { lockTimeoutMs: 20 }));
    release.open();
    await holder;
    expect(error).toBeInstanceOf(TransientDatabaseError);
    expect(error).toMatchObject({ reason: 'lock_timeout', sqlState: '55P03' });
  });

  it('classifies a deadlock as transient (the plain FOR UPDATE + FK KEY SHARE case avoided by FOR NO KEY UPDATE)', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const bothInserted = latch();
    let inserted = 0;
    // Mesma ordem do use case (insert da transação → lock da wallet), mas com `FOR UPDATE` puro: o KEY SHARE
    // da FK de cada INSERT bloqueia o FOR UPDATE do outro → o PostgreSQL detecta o deadlock.
    const attempt = () =>
      db.uow.run(async (em) => {
        await db.transactions.insertIfAbsent(betFor(wallet));
        inserted += 1;
        if (inserted === 2) {
          bothInserted.open();
        }
        await bothInserted.promise;
        await em.execute('select id from wallets where id = ? for update', [wallet.id]);
      });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBeInstanceOf(TransientDatabaseError);
    expect(failures[0]?.reason).toMatchObject({ reason: 'deadlock', sqlState: '40P01' });
  });

  it('does not deadlock in the same scenario with findByIdForUpdate (FOR NO KEY UPDATE)', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const bothInserted = latch();
    let inserted = 0;
    const attempt = () =>
      db.uow.run(async () => {
        await db.transactions.insertIfAbsent(betFor(wallet));
        inserted += 1;
        if (inserted === 2) {
          bothInserted.open();
        }
        await bothInserted.promise;
        return db.wallets.findByIdForUpdate(wallet.id);
      });
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('classifies a serialization failure as transient', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('0.00'));
    const bothRead = latch();
    let reads = 0;
    const attempt = (playerId: string) =>
      db.uow.run(
        async (em) => {
          await em.execute('select count(*) from wallets where player_id like ?', ['serial-%']);
          reads += 1;
          if (reads === 2) {
            bothRead.open();
          }
          await bothRead.promise;
          await em.execute('update wallets set player_id = ? where id = ?', [playerId, wallet.id]);
        },
        { isolation: 'serializable' },
      );
    const results = await Promise.allSettled([attempt('serial-a'), attempt('serial-b')]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBeInstanceOf(TransientDatabaseError);
    expect(['serialization', 'deadlock']).toContain(failures[0]?.reason.reason);
  });

  it('classifies a connection killed by the server as transient and does not leak the pooled client', async () => {
    // Pool de 1 conexão: se o client da transação morta vazasse, a próxima unidade de trabalho esperaria
    // para sempre (e o `close` também). O pool-guard o devolve ao pool depois de ~1s.
    const single = await openPersistence({ poolMax: 1 });
    try {
      const killOwnConnection = () =>
        captureError(
          single.uow.run(async (em) => {
            const [row] = await em.execute<{ pid: number }[]>('select pg_backend_pid() as pid');
            await appDb()`select pg_terminate_backend(${row?.pid ?? 0})`;
            await em.execute('select 1');
          }),
        );
      for (const error of [await killOwnConnection(), await killOwnConnection()]) {
        expect(error).toBeInstanceOf(TransientDatabaseError);
        expect(error).toMatchObject({ reason: 'connection' });
      }
      const ok = await single.uow.run(async (em) => (await em.execute<{ ok: number }[]>('select 1 as ok'))[0]?.ok);
      expect(ok).toBe(1);
    } finally {
      await single.close();
    }
  });

  it('rejects repository calls outside a unit of work and nested units of work', async () => {
    expect(() => db.uow.em).toThrow(UnitOfWorkScopeError);
    await expect(db.wallets.findById(crypto.randomUUID())).rejects.toBeInstanceOf(UnitOfWorkScopeError);
    const error = await captureError(db.uow.run(() => db.uow.run(async () => undefined)));
    expect(error).toBeInstanceOf(UnitOfWorkScopeError);
  });

  it('sets lock_timeout locally for each unit of work', async () => {
    const read = (lockTimeoutMs?: number) =>
      db.uow.run(
        async (em) => (await em.execute<{ lt: string }[]>("select current_setting('lock_timeout') as lt"))[0]?.lt,
        lockTimeoutMs === undefined ? {} : { lockTimeoutMs },
      );
    expect(await read(1234)).toBe('1234ms');
    expect(await read()).toBe('3s');
  });
});
