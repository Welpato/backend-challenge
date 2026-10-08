import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { CONSUMER_FAULT_EXIT_CODE } from '@/messaging/sqs/wager-consumer.worker';
import { Cluster } from '../../support/cluster';
import { closeDb, truncateAll } from '../../support/db';
import { metricValue } from '../../support/metrics';
import { queueDepth } from '../../support/sqs';
import { ledgerRows, operation, type TransactionInput } from '../../support/wagering-http';
import {
  assertFinalConsistency,
  balancesOf,
  createScenarioQueues,
  FAST_WORKERS_ENV,
  openWallets,
  type ScenarioQueues,
  sendOperation,
  statusCounts,
  sumMetric,
  waitForQueueEmpty,
  waitForSettled,
} from './multi-instance-kit';

/**
 * Cenário 5 (F13): um consumidor morre **depois do commit e antes do ack** (fault hook `FAULT_EXIT_AFTER_COMMIT`,
 * exit 137). A mensagem volta (visibility timeout) e é recebida por outro processo consumidor: a inbox impede o
 * segundo efeito. O consumidor condenado sobe sozinho primeiro, para ser ele quem pega as mensagens.
 */
let api: Cluster;
let doomed: Cluster | undefined;
let survivors: Cluster | undefined;
let queues: ScenarioQueues;

beforeAll(async () => {
  await truncateAll();
  queues = await createScenarioQueues('crash', 2);
  api = await Cluster.start([{ role: 'api', count: 1 }], { ...FAST_WORKERS_ENV, ...queues.env });
}, 60_000);

afterAll(async () => {
  await Promise.all([api?.stop(), doomed?.stop(), survivors?.stop()]);
  await queues?.delete();
  await closeDb();
}, 60_000);

describe('multi-instance — scenario 5', () => {
  it('consumer killed between commit and ack → redelivered to another process → no duplicated effect', async () => {
    const apiUrl = api.apiUrls()[0] as string;
    const wallets = await openWallets([apiUrl], 10, '100.00');
    const inputs: TransactionInput[] = wallets.flatMap((wallet) =>
      Array.from({ length: 5 }, () => operation(wallet, { money: { amount: '5.00', currency: 'BRL' } })),
    );
    for (const input of inputs) {
      await sendOperation(queues.wager.queue, input);
    }

    doomed = await Cluster.start([{ role: 'consumer', count: 1, env: { FAULT_EXIT_AFTER_COMMIT: '1' } }], {
      ...FAST_WORKERS_ENV,
      ...queues.env,
    });
    const victim = doomed.instances[0];
    expect(await victim?.exited(), victim?.output()).toBe(CONSUMER_FAULT_EXIT_CODE);
    // Pelo menos uma transação commitou sem ack: a mensagem dela continua na fila.
    expect((await statusCounts()).PROCESSED ?? 0).toBeGreaterThanOrEqual(1);
    expect(await queueDepth(queues.wager.queue)).toBe(inputs.length);

    survivors = await Cluster.start([{ role: 'consumer', count: 2 }], { ...FAST_WORKERS_ENV, ...queues.env });
    await waitForQueueEmpty(queues.wager.queue);
    expect(await waitForSettled(inputs.length)).toEqual({ PROCESSED: inputs.length });
    const duplicates = await sumMetric(
      survivors.instances.map((instance) => instance.baseUrl),
      (url) => metricValue(url, 'inbox_duplicates_total'),
    );
    expect(duplicates).toBeGreaterThanOrEqual(1);
    let entries = 0;
    for (const wallet of wallets) {
      entries += (await ledgerRows(wallet.walletId)).length;
    }
    expect(entries).toBe(inputs.length);
    expect(await balancesOf(wallets.map((wallet) => wallet.walletId))).toEqual(Array(10).fill('75.00'));
    expect(await queueDepth(queues.wager.dlq)).toBe(0);
    await assertFinalConsistency(
      apiUrl,
      wallets.map((wallet) => wallet.walletId),
    );
  }, 120_000);
});
