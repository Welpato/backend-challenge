import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '@/config/load-config';
import { buildMikroOrmConfig } from '@/shared/persistence/mikro-orm.config';
import { SpikeAccountSchema } from './spike-account.record';

// Spike da F00 contra PostgreSQL real (sem mocks). Exige a infra de teste no ar (docker-compose.test.yml).
const LOCK_HOLD_MS = 300;

let orm: MikroORM;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertAccount(balance: string): Promise<string> {
  const id = randomUUID();
  await orm.em.getConnection().execute('insert into spike_account (id, balance) values (?, ?)', [id, balance]);
  return id;
}

beforeAll(async () => {
  orm = await MikroORM.init(
    buildMikroOrmConfig({ clientUrl: loadConfig().database.url, entities: [SpikeAccountSchema] }),
  );
  await orm.migrator.up();
});

beforeEach(async () => {
  await orm.em.getConnection().execute('delete from spike_account');
});

afterAll(async () => {
  await orm.close(true);
});

describe('MikroORM under Bun (F00 spike)', () => {
  it('returns numeric(20,2) as string from the driver and the ORM', async () => {
    const id = await insertAccount('25.00');

    const rows = await orm.em
      .getConnection()
      .execute<{ balance: unknown }[]>('select balance from spike_account where id = ?', [id]);
    expect(rows[0]?.balance).toBe('25.00');

    const account = await orm.em.fork().findOneOrFail(SpikeAccountSchema, { id });
    expect(typeof account.balance).toBe('string');
    expect(account.balance).toBe('25.00');
  });

  it('keeps large values exact (no float rounding)', async () => {
    const id = await insertAccount('123456789012345678.99');
    const account = await orm.em.fork().findOneOrFail(SpikeAccountSchema, { id });
    expect(account.balance).toBe('123456789012345678.99');
  });

  it('commits inside em.transactional() and rolls back on error', async () => {
    const id = await insertAccount('10.00');

    await orm.em.fork().transactional(async (em) => {
      const account = await em.findOneOrFail(SpikeAccountSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      account.balance = '15.50';
      account.version += 1;
    });

    const failing = orm.em.fork().transactional(async (em) => {
      const account = await em.findOneOrFail(SpikeAccountSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      account.balance = '999.99';
      await em.flush();
      throw new Error('forced rollback');
    });
    await expect(failing).rejects.toThrow('forced rollback');

    const reloaded = await orm.em.fork().findOneOrFail(SpikeAccountSchema, { id });
    expect(reloaded.balance).toBe('15.50');
    expect(reloaded.version).toBe(1);
  });

  it('serializes writers on the same row with PESSIMISTIC_WRITE (SELECT ... FOR UPDATE)', async () => {
    const id = await insertAccount('0.00');
    const events: string[] = [];

    const first = orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(SpikeAccountSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      events.push('first:locked');
      await sleep(LOCK_HOLD_MS);
      events.push('first:commit');
    });

    await sleep(50);
    const startedAt = performance.now();
    const second = orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(SpikeAccountSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      events.push('second:locked');
    });

    await Promise.all([first, second]);
    const waitedMs = performance.now() - startedAt;

    expect(events).toEqual(['first:locked', 'first:commit', 'second:locked']);
    expect(waitedMs).toBeGreaterThanOrEqual(LOCK_HOLD_MS - 100);
  });

  it('does not block writers on different rows (lock is per row, not global)', async () => {
    const lockedId = await insertAccount('0.00');
    const otherId = await insertAccount('0.00');
    const events: string[] = [];

    const holder = orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(SpikeAccountSchema, { id: lockedId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      await sleep(LOCK_HOLD_MS);
      events.push('holder:commit');
    });

    await sleep(50);
    await orm.em.fork().transactional(async (em) => {
      await em.findOneOrFail(SpikeAccountSchema, { id: otherId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      events.push('other:locked');
    });
    await holder;

    expect(events).toEqual(['other:locked', 'holder:commit']);
  });
});
