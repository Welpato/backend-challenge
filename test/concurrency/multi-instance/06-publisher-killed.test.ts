import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Cluster } from '../../support/cluster';
import { appDb, closeDb, truncateAll } from '../../support/db';
import { waitFor } from '../../support/subprocess';
import { operation, submit } from '../../support/wagering-http';
import {
  createScenarioQueues,
  expectAllEventsPublished,
  FAST_WORKERS_ENV,
  openWallets,
  outboxIds,
  type ScenarioQueues,
  waitForOutboxDrained,
} from './multi-instance-kit';

/**
 * Cenário 6 (F13): dois publishers da outbox (processos reais) sobre a mesma outbox; um deles leva `SIGKILL` no
 * meio da publicação. Locks `SKIP LOCKED` do morto caem com a conexão; o sobrevivente publica tudo.
 */
let api: Cluster;
let publishers: Cluster | undefined;
let queues: ScenarioQueues;

beforeAll(async () => {
  await truncateAll();
  queues = await createScenarioQueues('publishers');
  api = await Cluster.start([{ role: 'api', count: 1 }], queues.env);
}, 60_000);

afterAll(async () => {
  await Promise.all([api?.stop(), publishers?.stop()]);
  await queues?.delete();
  await closeDb();
}, 60_000);

async function publishedCount(): Promise<number> {
  const [row] = await appDb()`select count(published_at)::int as n from outbox_messages`;
  return (row as { n: number }).n;
}

describe('multi-instance — scenario 6', () => {
  it('two publishers, one SIGKILLed mid-run → every outbox event is published (duplicates carry the same eventId)', async () => {
    const apiUrl = api.apiUrls()[0] as string;
    const wallets = await openWallets([apiUrl], 20, '1000.00');
    for (const wallet of wallets) {
      await Promise.all(
        Array.from({ length: 10 }, () =>
          submit(apiUrl, operation(wallet, { money: { amount: '1.00', currency: 'BRL' } })),
        ),
      );
    }
    const total = (await outboxIds()).length;
    expect(total).toBe(20 * 2 + 200 * 2);

    publishers = await Cluster.start([{ role: 'outbox', count: 2 }], {
      ...FAST_WORKERS_ENV,
      ...queues.env,
      OUTBOX_BATCH_SIZE: '5',
    });
    await waitFor(async () => (await publishedCount()) >= 40, 30_000, 'publication under way', 10);
    const victim = publishers.instances[0];
    expect(await victim?.kill('SIGKILL')).toBe(137);
    const publishedAtKill = await publishedCount();

    await waitForOutboxDrained();
    expect(publishedAtKill).toBeLessThanOrEqual(total);
    await expectAllEventsPublished(queues.events);
    expect(publishers.instances[1]?.isRunning()).toBe(true);
  }, 120_000);
});
