import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ConcurrencyInvariantError } from '@/shared/persistence/persistence.errors';
import { TransientDatabaseError } from '@/shared/persistence/pg-errors';
import type { Wallet } from '@/wallet/domain/wallet';
import { closeDb, truncateAll } from '../../support/db';
import { captureError, type Latch, latch, openPersistence, type Persistence, sleep } from '../../support/persistence';
import { AT, betFor, brl, persistOpenedWallet } from './persistence-fixtures';

const HOLD_MS = 400;
/** Folga para a resolução do timer/agendamento ao comparar instantes. */
const TOLERANCE_MS = 25;

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

/**
 * Débito completo (como o use case fará): insere a BET, trava a wallet, debita, grava saldo/versão e
 * lançamento, marca a BET como processada. Sinaliza `locked` assim que tem o lock e o segura por `holdMs`.
 */
async function debitHoldingLock(wallet: Wallet, amount: string, locked: Latch, holdMs: number): Promise<void> {
  const bet = betFor(wallet, { money: brl(amount) });
  await db.uow.run(async () => {
    await db.transactions.insertIfAbsent(bet);
    const current = await db.wallets.findByIdForUpdate(wallet.id);
    if (current === undefined) {
      throw new Error('wallet not found');
    }
    locked.open();
    await sleep(holdMs);
    const expectedVersion = current.version;
    const entry = current.debit(bet.id, bet.money, AT);
    await db.wallets.updateBalance(current, expectedVersion);
    await db.ledger.append(entry);
    bet.markProcessed(undefined, current.balance, AT);
    await db.transactions.save(bet);
  });
}

describe('WalletRepository.findByIdForUpdate', () => {
  it('makes a second transaction wait until the first commits, and then reads the committed state', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const firstLocked = latch();
    let firstCommittedAt = 0;

    const first = debitHoldingLock(wallet, '30.00', firstLocked, HOLD_MS).then(() => {
      firstCommittedAt = performance.now();
    });
    await firstLocked.promise;
    const secondStartedAt = performance.now();
    const second = db.uow.run(async () => {
      const locked = await db.wallets.findByIdForUpdate(wallet.id);
      return { locked, acquiredAt: performance.now() };
    });

    await first;
    const { locked, acquiredAt } = await second;

    expect(acquiredAt - secondStartedAt).toBeGreaterThanOrEqual(HOLD_MS - TOLERANCE_MS);
    expect(acquiredAt).toBeGreaterThanOrEqual(firstCommittedAt - TOLERANCE_MS);
    expect(locked?.balance.toJSON().amount).toBe('70.00');
    expect(locked?.version).toBe(2);
  });

  it('serializes concurrent debits on the same wallet without losing updates', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const debits = Array.from({ length: 10 }, () => debitHoldingLock(wallet, '7.00', latch(), 0));
    await Promise.all(debits);

    const [current, totals] = await db.uow.run(async () => [
      await db.wallets.findById(wallet.id),
      await db.ledger.aggregate(wallet.id),
    ]);
    expect(current?.balance.toJSON().amount).toBe('30.00');
    expect(current?.version).toBe(11);
    expect(totals).toEqual({ walletId: wallet.id, credits: '100.00', debits: '70.00', entries: 11 });
  });

  it('does not block reads without lock (findById) while the wallet is locked', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const firstLocked = latch();
    const first = debitHoldingLock(wallet, '30.00', firstLocked, HOLD_MS);
    await firstLocked.promise;
    const startedAt = performance.now();
    const read = await db.uow.run(() => db.wallets.findById(wallet.id));
    expect(performance.now() - startedAt).toBeLessThan(HOLD_MS);
    expect(read?.balance.toJSON().amount).toBe('100.00');
    await first;
  });

  it('fails with a transient error when the lock is not granted within lock_timeout', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const firstLocked = latch();
    const first = debitHoldingLock(wallet, '30.00', firstLocked, HOLD_MS);
    await firstLocked.promise;

    const startedAt = performance.now();
    const error = await captureError(db.uow.run(() => db.wallets.findByIdForUpdate(wallet.id), { lockTimeoutMs: 50 }));
    const waited = performance.now() - startedAt;

    expect(error).toBeInstanceOf(TransientDatabaseError);
    expect(error).toMatchObject({ reason: 'lock_timeout', sqlState: '55P03' });
    expect(waited).toBeLessThan(HOLD_MS);
    await first;
  });
});

describe('WalletRepository.updateBalance', () => {
  it('throws ConcurrencyInvariantError and rolls back when the expected version is wrong', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const bet = betFor(wallet);

    const error = await captureError(
      db.uow.run(async () => {
        await db.transactions.insertIfAbsent(bet);
        const current = await db.wallets.findByIdForUpdate(wallet.id);
        if (current === undefined) {
          throw new Error('wallet not found');
        }
        current.debit(bet.id, bet.money, AT);
        await db.wallets.updateBalance(current, 7);
      }),
    );

    expect(error).toBeInstanceOf(ConcurrencyInvariantError);
    const [current, insertedBet] = await db.uow.run(async () => [
      await db.wallets.findById(wallet.id),
      await db.transactions.findById(bet.id),
    ]);
    expect(current?.balance.toJSON().amount).toBe('100.00');
    expect(current?.version).toBe(1);
    expect(insertedBet).toBeUndefined();
  });
});
