import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { FailureCode } from '@/shared/failure-code';
import { Money } from '@/shared/money/money';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import { closeDb, migratorDb, truncateAll } from '../../support/db';
import { openPersistence, type Persistence } from '../../support/persistence';
import { AT, betFor, brl, inboxMessage, outboxMessageFor, persistOpenedWallet } from './persistence-fixtures';

const MAX = '999999999999999999.99';
const LATER = new Date('2026-10-07T12:00:05.456Z');

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

describe('persistence round-trip (domain → database → domain)', () => {
  it('connects as the app role', async () => {
    const [row] = await db.uow.run((em) => em.execute<{ user: string }[]>('select current_user as "user"'));
    expect(row?.user).toBe('app');
  });

  it('round-trips a wallet, its opening transaction and ledger entry with the maximum NUMERIC(20,2) amount', async () => {
    const { wallet, opening, openingEntry } = await persistOpenedWallet(db, brl(MAX));
    if (opening === undefined || openingEntry === undefined) {
      throw new Error('fixture must create an opening');
    }

    const [loadedWallet, loadedTx, entries] = await db.uow.run(async () => [
      await db.wallets.findById(wallet.id),
      await db.transactions.findById(opening.id),
      await db.ledger.page(wallet.id, 0, 10),
    ]);

    expect(loadedWallet).toEqual(wallet);
    expect(loadedWallet?.balance.toJSON()).toEqual({ amount: MAX, currency: 'BRL' });
    expect(loadedWallet?.version).toBe(1);
    expect(loadedTx).toEqual(opening);
    expect(loadedTx?.balanceAfter?.toJSON()).toEqual({ amount: MAX, currency: 'BRL' });
    expect(entries).toEqual([openingEntry]);
    expect(entries[0]?.balanceAfter.toJSON().amount).toBe(MAX);
    expect(entries[0]?.isBalanced()).toBe(true);

    const [stored] = await migratorDb()<
      { balance: string }[]
    >`select balance::text from wallets where id = ${wallet.id}`;
    expect(stored?.balance).toBe(MAX);
  });

  it('round-trips a wallet opened with zero balance (no opening transaction)', async () => {
    const { wallet, opening } = await persistOpenedWallet(db, Money.zero('BRL'));
    expect(opening).toBeUndefined();
    const loaded = await db.uow.run(() => db.wallets.findById(wallet.id));
    expect(loaded).toEqual(wallet);
    expect(loaded?.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  it('round-trips a debit: wallet version, ledger entry and processed transaction snapshot', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const bet = betFor(wallet, { money: brl('25.10') });

    await db.uow.run(async () => {
      expect(await db.transactions.insertIfAbsent(bet)).toEqual({ inserted: true });
      const locked = await db.wallets.findByIdForUpdate(wallet.id);
      if (locked === undefined) {
        throw new Error('wallet not found');
      }
      const expectedVersion = locked.version;
      const entry = locked.debit(bet.id, bet.money, LATER);
      await db.wallets.updateBalance(locked, expectedVersion);
      await db.ledger.append(entry);
      bet.markProcessed(undefined, locked.balance, LATER);
      await db.transactions.save(bet);
    });

    const [loadedWallet, loadedBet, entries] = await db.uow.run(async () => [
      await db.wallets.findById(wallet.id),
      await db.transactions.findById(bet.id),
      await db.ledger.page(wallet.id, 1, 10),
    ]);
    expect(loadedWallet?.balance.toJSON().amount).toBe('74.90');
    expect(loadedWallet?.version).toBe(2);
    expect(loadedWallet?.updatedAt).toEqual(LATER);
    expect(loadedBet).toEqual(bet);
    expect(loadedBet?.status).toBe(WagerTransactionStatus.Processed);
    expect(loadedBet?.balanceAfter?.toJSON()).toEqual({ amount: '74.90', currency: 'BRL' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ transactionId: bet.id, walletVersion: 2 });
    expect(entries[0]?.money.toJSON().amount).toBe('25.10');
    expect(entries[0]?.balanceBefore.toJSON().amount).toBe('100.00');
  });

  it('round-trips every optional column of a transaction (reference, failure, foreign-currency snapshot)', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const usdRefund = betFor(wallet, {
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '10.00', currency: 'USD' }),
      referenceExternalTransactionId: 'ext-original-bet',
    });
    usdRefund.reject(FailureCode.CURRENCY_MISMATCH, wallet.balance, LATER);

    await db.uow.run(async () => {
      await db.transactions.insertIfAbsent(usdRefund);
    });

    const loaded = await db.uow.run(() =>
      db.transactions.findByProviderExternalId('provider-a', usdRefund.externalTransactionId),
    );
    expect(loaded).toEqual(usdRefund);
    expect(loaded?.money.toJSON()).toEqual({ amount: '10.00', currency: 'USD' });
    expect(loaded?.balanceAfter?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(loaded?.failureCode).toBe(FailureCode.CURRENCY_MISMATCH);
    expect(loaded?.referenceExternalTransactionId).toBe('ext-original-bet');
    expect(loaded?.processedAt).toEqual(LATER);
  });

  it('round-trips a pending-reference transaction and its rescheduling', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const win = betFor(wallet, { kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'ext-missing' });
    await db.uow.run(async () => {
      await db.transactions.insertIfAbsent(win);
      win.markPendingReference(LATER);
      await db.transactions.save(win);
    });
    const firstLoad = await db.uow.run(() => db.transactions.findById(win.id));
    expect(firstLoad).toEqual(win);
    expect(firstLoad?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(firstLoad?.referenceTransactionId).toBeUndefined();
    expect(firstLoad?.balanceAfter).toBeUndefined();

    const next = new Date(LATER.getTime() + 2000);
    await db.uow.run(async () => {
      const current = await db.transactions.findById(win.id);
      current?.scheduleNextReferenceAttempt(next);
      if (current !== undefined) {
        await db.transactions.save(current);
      }
    });
    const secondLoad = await db.uow.run(() => db.transactions.findReference('provider-a', win.externalTransactionId));
    expect(secondLoad?.attempts).toBe(1);
    expect(secondLoad?.nextAttemptAt).toEqual(next);
  });

  it('round-trips inbox messages', async () => {
    const message = inboxMessage();
    await db.uow.run(async () => {
      expect(await db.inbox.insertIfAbsent(message)).toEqual({ inserted: true });
    });
    message.markProcessed(LATER);
    await db.uow.run(() => db.inbox.markProcessed(message));

    const again = inboxMessage(message.messageId);
    const result = await db.uow.run(() => db.inbox.insertIfAbsent(again));
    expect(result).toEqual({ inserted: false, existing: message });
    if (!result.inserted) {
      expect(result.existing.isProcessed()).toBe(true);
      expect(result.existing.processedAt).toEqual(LATER);
    }
  });

  it('round-trips outbox messages with the event payload intact (money as strings)', async () => {
    const { wallet, openingEntry } = await persistOpenedWallet(db, brl(MAX));
    if (openingEntry === undefined) {
      throw new Error('fixture must create an opening entry');
    }
    const message = outboxMessageFor(wallet, openingEntry);
    await db.uow.run(() => db.outbox.enqueue([message]));

    const [claimed] = await db.uow.run(() => db.outbox.claimDue(10));
    expect(claimed).toEqual(message);
    expect(claimed?.payload).toEqual(message.payload);
    expect(JSON.stringify(claimed?.payload)).toContain(`"amount":"${MAX}"`);
    expect(claimed?.occurredAt).toEqual(AT);

    message.scheduleRetry(LATER, 'SQS unavailable', { jitterRatio: 0 });
    await db.uow.run(() => db.outbox.save(message));
    const [retried] = await db.uow.run(() => db.outbox.claimDue(10));
    expect(retried).toEqual(message);
    expect(retried?.attempts).toBe(1);
    expect(retried?.lastError).toBe('SQS unavailable');

    message.markPublished(LATER);
    await db.uow.run(() => db.outbox.save(message));
    expect(await db.uow.run(() => db.outbox.claimDue(10))).toEqual([]);
    const [row] = await migratorDb()<{ attempts: number; published_at: Date | null }[]>`
      select attempts, published_at from outbox_messages where id = ${message.id}`;
    expect(row).toEqual({ attempts: 1, published_at: LATER });
  });
});
