import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { OutboxMessage } from '@/messaging/outbox/outbox-message';
import { FixedClock } from '@/shared/clock';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';
import { closeDb, truncateAll } from '../../support/db';
import { latch, openPersistence, type Persistence } from '../../support/persistence';
import { AT, betFor, brl, outboxMessageFor, persistOpenedWallet } from './persistence-fixtures';

const NOW = new Date('2026-10-07T13:00:00.000Z');
const LEASE_MS = 30_000;

let clock: FixedClock;
let db: Persistence;

beforeAll(async () => {
  clock = new FixedClock(NOW);
  db = await openPersistence({ clock });
});

afterAll(async () => {
  await db.close();
  await closeDb();
});

beforeEach(async () => {
  clock.set(NOW);
  await truncateAll();
});

/**
 * Roda `claim` em duas transações simultâneas: ambas fazem a reivindicação antes de qualquer uma
 * commitar (as duas esperam o latch), então os locks das duas coexistem.
 */
async function claimInTwoTransactions<T>(claim: () => Promise<T[]>): Promise<[T[], T[]]> {
  const bothClaimed = latch();
  let claimed = 0;
  const run = () =>
    db.uow.run(async () => {
      const rows = await claim();
      claimed += 1;
      if (claimed === 2) {
        bothClaimed.open();
      }
      await bothClaimed.promise;
      return rows;
    });
  // Qual das duas transações reivindica primeiro não é determinístico: devolve a maior primeiro (corrige o
  // teste intermitente registrado na F07/F08, que assumia a ordem do Promise.all).
  const results = await Promise.all([run(), run()]);
  return results.sort((a, b) => b.length - a.length) as [T[], T[]];
}

async function enqueueOutbox(count: number): Promise<OutboxMessage[]> {
  const { wallet, openingEntry } = await persistOpenedWallet(db, brl('100.00'));
  if (openingEntry === undefined) {
    throw new Error('fixture must create an opening entry');
  }
  const messages = Array.from({ length: count }, (_, i) =>
    outboxMessageFor(wallet, openingEntry, new Date(AT.getTime() + i)),
  );
  await db.uow.run(() => db.outbox.enqueue(messages));
  return messages;
}

describe('OutboxRepository.claimDue', () => {
  it('returns disjoint sets to two simultaneous transactions (FOR UPDATE SKIP LOCKED)', async () => {
    const messages = await enqueueOutbox(10);
    const [first, second] = await claimInTwoTransactions(() => db.outbox.claimDue(6));

    expect(first).toHaveLength(6);
    expect(second).toHaveLength(4);
    const firstIds = first.map((m) => m.id);
    const secondIds = second.map((m) => m.id);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    expect([...firstIds, ...secondIds].sort()).toEqual(messages.map((m) => m.id).sort());
  });

  it('orders by occurred_at and skips published and not-yet-due messages', async () => {
    const messages = await enqueueOutbox(4);
    const [published, notDue] = [messages[0], messages[1]];
    if (published === undefined || notDue === undefined) {
      throw new Error('fixture');
    }
    published.markPublished(NOW);
    notDue.scheduleRetry(NOW, 'boom', { jitterRatio: 0 });
    await db.uow.run(async () => {
      await db.outbox.save(published);
      await db.outbox.save(notDue);
    });

    const due = await db.uow.run(() => db.outbox.claimDue(10));
    expect(due.map((m) => m.id)).toEqual([messages[2]?.id ?? '', messages[3]?.id ?? '']);

    clock.advance(2_000);
    const later = await db.uow.run(() => db.outbox.claimDue(10));
    expect(later.map((m) => m.id)).toEqual([notDue.id, messages[2]?.id ?? '', messages[3]?.id ?? '']);
  });

  it('releases the rows when the claiming transaction rolls back', async () => {
    await enqueueOutbox(3);
    await db.uow
      .run(async () => {
        expect(await db.outbox.claimDue(10)).toHaveLength(3);
        throw new Error('publisher crashed');
      })
      .catch(() => undefined);
    expect(await db.uow.run(() => db.outbox.claimDue(10))).toHaveLength(3);
  });

  it('reports pending count and the age of the oldest pending message', async () => {
    expect(await db.uow.run(() => db.outbox.stats())).toEqual({
      pending: 0,
      oldestPendingOccurredAt: undefined,
      oldestPendingAgeSeconds: 0,
    });
    const messages = await enqueueOutbox(3);
    messages[0]?.markPublished(NOW);
    await db.uow.run(async () => {
      if (messages[0] !== undefined) {
        await db.outbox.save(messages[0]);
      }
    });
    const stats = await db.uow.run(() => db.outbox.stats());
    expect(stats.pending).toBe(2);
    expect(stats.oldestPendingOccurredAt).toEqual(new Date(AT.getTime() + 1));
    expect(stats.oldestPendingAgeSeconds).toBe((NOW.getTime() - AT.getTime() - 1) / 1000);
  });
});

describe('WagerTransactionRepository.claimDuePendingReferences', () => {
  async function pendingTransactions(count: number): Promise<WagerTransaction[]> {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const txs = Array.from({ length: count }, (_, i) => {
      const tx = betFor(wallet, { kind: WagerTransactionKind.Win, referenceExternalTransactionId: `ext-missing-${i}` });
      tx.markPendingReference(new Date(NOW.getTime() - 1000 + i));
      return tx;
    });
    await db.uow.run(async () => {
      for (const tx of txs) {
        await db.transactions.insertIfAbsent(tx);
      }
    });
    return txs;
  }

  it('returns disjoint sets to two simultaneous transactions and leases the claimed rows', async () => {
    const txs = await pendingTransactions(8);
    const [first, second] = await claimInTwoTransactions(() => db.transactions.claimDuePendingReferences(5, LEASE_MS));

    expect(first).toHaveLength(5);
    expect(second).toHaveLength(3);
    expect(first.filter((id) => second.includes(id))).toEqual([]);
    expect([...first, ...second].sort()).toEqual(txs.map((tx) => tx.id).sort());

    const leased = await db.uow.run(() => db.transactions.findById(first[0] as string));
    expect(leased?.nextAttemptAt).toEqual(new Date(NOW.getTime() + LEASE_MS));
    expect(leased?.attempts).toBe(0);

    // Lease ativo: ninguém pega de novo até ele vencer.
    expect(await db.uow.run(() => db.transactions.claimDuePendingReferences(10, LEASE_MS))).toEqual([]);
    clock.advance(LEASE_MS);
    expect(await db.uow.run(() => db.transactions.claimDuePendingReferences(10, LEASE_MS))).toHaveLength(8);
  });

  it('ignores transactions that are not pending or not yet due', async () => {
    const [due, future] = await pendingTransactions(2);
    if (due === undefined || future === undefined) {
      throw new Error('fixture');
    }
    future.scheduleNextReferenceAttempt(new Date(NOW.getTime() + 60_000));
    await db.uow.run(() => db.transactions.save(future));

    const { wallet } = await persistOpenedWallet(db, brl('10.00'));
    await db.uow.run(() => db.transactions.insertIfAbsent(betFor(wallet)));

    expect(await db.uow.run(() => db.transactions.claimDuePendingReferences(10, LEASE_MS))).toEqual([due.id]);
  });
});
