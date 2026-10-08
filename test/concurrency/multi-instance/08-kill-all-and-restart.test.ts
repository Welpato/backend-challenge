import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Cluster } from '../../support/cluster';
import { closeDb, truncateAll } from '../../support/db';
import { type DistributedResult, LoadClient } from '../../support/load-client';
import { queueDepth } from '../../support/sqs';
import { waitFor } from '../../support/subprocess';
import { operation, type TransactionInput } from '../../support/wagering-http';
import {
  assertFinalConsistency,
  balancesOf,
  createScenarioQueues,
  expectAllEventsPublished,
  FAST_WORKERS_ENV,
  openWallets,
  type ScenarioQueues,
  sendOperation,
  statusCounts,
  waitForOutboxDrained,
  waitForQueueEmpty,
  waitForSettled,
} from './multi-instance-kit';

/**
 * Cenário 8 (F13): `SIGKILL` em **todos** os processos (3 APIs, 3 consumidores, 2 publishers, 2 reprocessadores)
 * no meio da carga HTTP + fila. Depois do reinício, o provedor reenvia (mesma key) o que não teve resposta
 * definitiva e o sistema converge: reconciliação `consistent: true` em todas as wallets, fila e DLQ vazias,
 * outbox zerada e todos os eventos publicados.
 */
let cluster: Cluster;
let queues: ScenarioQueues;

const WALLETS = 20;
const HTTP_PER_WALLET = 10;
const QUEUE_PER_WALLET = 10;
/** Requisições HTTP em voo ao mesmo tempo (a carga dura alguns segundos — o SIGKILL cai no meio dela). */
const HTTP_CONCURRENCY = 6;

beforeAll(async () => {
  await truncateAll();
  queues = await createScenarioQueues('restart');
  cluster = await Cluster.start(
    [
      { role: 'api', count: 3 },
      { role: 'consumer', count: 3 },
      { role: 'outbox', count: 2 },
      { role: 'reprocessor', count: 2 },
    ],
    { ...FAST_WORKERS_ENV, ...queues.env },
  );
}, 90_000);

afterAll(async () => {
  await cluster?.stop();
  await queues?.delete();
  await closeDb();
}, 60_000);

/** Resposta definitiva = o provedor não precisa reenviar (inclusive 202 pendente). */
function definitive(result: DistributedResult): boolean {
  return [200, 201, 202].includes(result.status);
}

describe('multi-instance — scenario 8', () => {
  it('SIGKILL of every process mid-load → restart → provider retries → consistent ledger, nothing lost', async () => {
    const urls = cluster.apiUrls();
    const client = new LoadClient(urls, 20261008);
    const wallets = await openWallets(urls, WALLETS, '1000.00');
    const http: TransactionInput[] = [];
    const viaQueue: TransactionInput[] = [];
    for (const [w, wallet] of wallets.entries()) {
      const money = { amount: '5.00', currency: 'BRL' };
      // REFUND antes da BET: atravessa o crash como PENDING_REFERENCE e é resolvido depois do reinício.
      http.push(operation(wallet, { kind: 'REFUND', referenceExternalTransactionId: `bet-${w}-0`, money }));
      for (let i = 0; i < HTTP_PER_WALLET; i += 1) {
        http.push(operation(wallet, { externalTransactionId: `bet-${w}-${i}`, money }));
      }
      for (let i = 0; i < QUEUE_PER_WALLET; i += 1) {
        viaQueue.push(operation(wallet, { externalTransactionId: `qbet-${w}-${i}`, money }));
      }
    }
    for (const input of viaQueue) {
      await sendOperation(queues.wager.queue, input);
    }

    // Carga HTTP com concorrência limitada; o SIGKILL acontece quando ~1/3 das transações já existem.
    const results: DistributedResult[] = new Array(http.length);
    let cursor = 0;
    const workers = Array.from({ length: HTTP_CONCURRENCY }, async () => {
      while (cursor < http.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await client.submitTo(client.pick(), http[index] as TransactionInput);
      }
    });
    const total = http.length + viaQueue.length;
    await waitFor(
      async () => Object.values(await statusCounts()).reduce((sum, n) => sum + n, 0) >= total / 3,
      60_000,
      'load under way',
      20,
    );
    const exitCodes = await cluster.killAll('SIGKILL');
    expect(exitCodes).toEqual(Array(cluster.instances.length).fill(137));
    await Promise.all(workers);
    const beforeRestart = Object.values(await statusCounts()).reduce((sum, n) => sum + n, 0);
    expect(beforeRestart).toBeLessThan(total);
    expect(results.some((result) => !definitive(result))).toBe(true);

    await cluster.restartStopped();
    // O provedor reenvia, com a mesma key, tudo o que não teve resposta definitiva.
    for (const [index, result] of results.entries()) {
      if (!definitive(result)) {
        results[index] = await client.submitTo(client.pick(), http[index] as TransactionInput);
      }
    }
    expect(results.filter((result) => !definitive(result))).toEqual([]);

    expect(await waitForSettled(total, 90_000)).toEqual({ PROCESSED: total });
    await waitForQueueEmpty(queues.wager.queue);
    expect(await queueDepth(queues.wager.dlq)).toBe(0);
    // 1000 − 20 × 5.00 + 5.00 (REFUND) = 905.00 em toda wallet.
    expect(await balancesOf(wallets.map((wallet) => wallet.walletId))).toEqual(Array(WALLETS).fill('905.00'));
    await waitForOutboxDrained();
    await expectAllEventsPublished(queues.events);
    await assertFinalConsistency(
      urls[1] as string,
      wallets.map((wallet) => wallet.walletId),
    );
  }, 240_000);
});
