import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { closeDb, migratorDb, truncateAll } from '../../support/db';
import { openPersistence, type Persistence } from '../../support/persistence';
import { betFor, brl, inboxMessage, persistOpenedWallet } from './persistence-fixtures';

const CONCURRENCY = 20;

let db: Persistence;

beforeAll(async () => {
  db = await openPersistence({ poolMax: CONCURRENCY + 5 });
});

afterAll(async () => {
  await db.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

/** Quantas conexões distintas do `app` participaram (pids dos backends). */
async function backendPid(): Promise<number> {
  const [row] = await db.uow.em.execute<{ pid: number }[]>('select pg_backend_pid() as pid');
  if (row === undefined) {
    throw new Error('no backend pid');
  }
  return row.pid;
}

describe('WagerTransactionRepository.insertIfAbsent', () => {
  it(`lets exactly one of ${CONCURRENCY} concurrent inserts with the same key win`, async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const template = betFor(wallet);
    // Cada tentativa é uma instância nova (id novo), como requisições/mensagens independentes.
    const attempts = Array.from({ length: CONCURRENCY }, () =>
      betFor(wallet, {
        externalTransactionId: template.externalTransactionId,
        idempotencyKey: template.idempotencyKey,
      }),
    );

    const results = await Promise.all(
      attempts.map((tx) =>
        db.uow.run(async () => {
          const pid = await backendPid();
          const result = await db.transactions.insertIfAbsent(tx);
          return { tx, pid, result };
        }),
      ),
    );

    const winners = results.filter(({ result }) => result.inserted);
    expect(winners).toHaveLength(1);
    expect(new Set(results.map(({ pid }) => pid)).size).toBe(CONCURRENCY);
    const winnerId = winners[0]?.tx.id;
    for (const { result } of results) {
      if (!result.inserted) {
        expect(result.existing.id).toBe(winnerId as string);
        expect(result.existing.matchesPayload(template.payloadHash)).toBe(true);
      }
    }
    const [row] = await migratorDb()<{ count: string }[]>`
      select count(*)::text as count from wager_transactions where idempotency_key = ${template.idempotencyKey}`;
    expect(row?.count).toBe('1');
  });

  it('returns the existing row found by idempotency key when the payload differs (conflict decided by the caller)', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const original = betFor(wallet);
    const conflicting = betFor(wallet, { idempotencyKey: original.idempotencyKey, money: brl('99.00') });

    await db.uow.run(() => db.transactions.insertIfAbsent(original));
    const result = await db.uow.run(() => db.transactions.insertIfAbsent(conflicting));

    expect(result.inserted).toBe(false);
    if (!result.inserted) {
      expect(result.existing).toEqual(original);
      expect(result.existing.matchesPayload(conflicting.payloadHash)).toBe(false);
    }
  });

  it('falls back to (provider, external id) when the key is new but the external id already exists', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const original = betFor(wallet);
    const sameExternalId = betFor(wallet, {
      externalTransactionId: original.externalTransactionId,
      idempotencyKey: 'another-key',
    });

    await db.uow.run(() => db.transactions.insertIfAbsent(original));
    const result = await db.uow.run(() => db.transactions.insertIfAbsent(sameExternalId));

    expect(result).toEqual({ inserted: false, existing: original });
  });

  it('accepts the same external id from another provider', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const original = betFor(wallet);
    const otherProvider = betFor(wallet, {
      providerId: 'provider-b',
      externalTransactionId: original.externalTransactionId,
      idempotencyKey: 'provider-b-key',
    });
    await db.uow.run(() => db.transactions.insertIfAbsent(original));
    expect(await db.uow.run(() => db.transactions.insertIfAbsent(otherProvider))).toEqual({ inserted: true });
  });

  it('inserts again after a concurrent winner rolls back', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const tx = betFor(wallet);
    await db.uow
      .run(async () => {
        await db.transactions.insertIfAbsent(tx);
        throw new Error('rollback');
      })
      .catch(() => undefined);
    const retry = betFor(wallet, {
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
    });
    expect(await db.uow.run(() => db.transactions.insertIfAbsent(retry))).toEqual({ inserted: true });
  });
});

describe('InboxRepository.insertIfAbsent', () => {
  it(`lets exactly one of ${CONCURRENCY} concurrent deliveries of the same message win`, async () => {
    const template = inboxMessage();
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        db.uow.run(() => db.inbox.insertIfAbsent(inboxMessage(template.messageId))),
      ),
    );
    expect(results.filter((result) => result.inserted)).toHaveLength(1);
    for (const result of results) {
      if (!result.inserted) {
        expect(result.existing).toEqual(template);
      }
    }
  });

  it('returns the existing message with its own payload hash (the consumer compares hashes)', async () => {
    const first = inboxMessage('msg-1', 'payload-a');
    await db.uow.run(() => db.inbox.insertIfAbsent(first));
    const result = await db.uow.run(() => db.inbox.insertIfAbsent(inboxMessage('msg-1', 'payload-b')));
    expect(result).toEqual({ inserted: false, existing: first });
  });
});
