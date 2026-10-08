import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Cluster } from '../../support/cluster';
import { closeDb, truncateAll } from '../../support/db';
import { LoadClient } from '../../support/load-client';
import { metricValue } from '../../support/metrics';
import { queueDepth } from '../../support/sqs';
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
  sumMetric,
  waitForOutboxDrained,
  waitForQueueEmpty,
  waitForSettled,
} from './multi-instance-kit';

/**
 * Cenário 4 (F13): 3 APIs + 3 consumidores + 2 publishers + 2 reprocessadores, todos processos reais ao mesmo
 * tempo, com carga mista HTTP e fila — inclusive duplicatas (na fila e entre canais) e reversões que chegam antes
 * da referência. O resultado é determinístico por wallet, qualquer que seja a ordem de chegada.
 */
let cluster: Cluster;
let queues: ScenarioQueues;

const WALLETS = 20;

beforeAll(async () => {
  await truncateAll();
  queues = await createScenarioQueues('mixed');
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

describe('multi-instance — scenario 4', () => {
  it('mixed HTTP + SQS load with duplicates and early reversals on every role → exact balances and all invariants', async () => {
    const urls = cluster.apiUrls();
    const wallets = await openWallets(urls, WALLETS, '1000.00');
    const http: TransactionInput[] = [];
    const viaQueue: { input: TransactionInput; messageId: string; copies: number }[] = [];

    for (const [w, wallet] of wallets.entries()) {
      const bet = (i: number) =>
        operation(wallet, { externalTransactionId: `bet-${w}-${i}`, money: { amount: '10.00', currency: 'BRL' } });
      const bets = Array.from({ length: 6 }, (_, i) => bet(i));
      const wins = [0, 1].map((i) =>
        operation(wallet, {
          kind: 'WIN',
          externalTransactionId: `win-${w}-${i}`,
          referenceExternalTransactionId: `bet-${w}-${i + 1}`,
          money: { amount: '15.00', currency: 'BRL' },
        }),
      );
      const refund = operation(wallet, {
        kind: 'REFUND',
        externalTransactionId: `refund-${w}`,
        referenceExternalTransactionId: `bet-${w}-0`,
        money: { amount: '10.00', currency: 'BRL' },
      });
      const rollback = operation(wallet, {
        kind: 'ROLLBACK',
        externalTransactionId: `rollback-${w}`,
        referenceExternalTransactionId: `win-${w}-0`,
        money: { amount: '15.00', currency: 'BRL' },
      });
      // Metade por HTTP, metade pela fila; a BET 1 vai pelos dois canais (mesma key → um efeito) e as
      // mensagens da fila são enviadas 2× com o mesmo messageId (dedup da inbox).
      http.push(
        bets[0] as TransactionInput,
        bets[1] as TransactionInput,
        bets[2] as TransactionInput,
        wins[0] as TransactionInput,
        refund,
      );
      http.push(bets[1] as TransactionInput); // duplicata no próprio HTTP
      for (const [i, input] of [bets[1], bets[3], bets[4], bets[5], wins[1], rollback].entries()) {
        viaQueue.push({ input: input as TransactionInput, messageId: `msg-${w}-${i}`, copies: 2 });
      }
    }

    const client = new LoadClient(urls, 20261004);
    const [results] = await Promise.all([
      client.submitAll(http),
      (async () => {
        for (const message of viaQueue) {
          for (let copy = 0; copy < message.copies; copy += 1) {
            await sendOperation(queues.wager.queue, message.input, message.messageId);
          }
        }
      })(),
    ]);

    expect(results.filter((result) => ![200, 201, 202].includes(result.status))).toEqual([]);
    const counts = await waitForSettled(WALLETS * 10);
    expect(counts).toEqual({ PROCESSED: WALLETS * 10 });
    await waitForQueueEmpty(queues.wager.queue);
    expect(await queueDepth(queues.wager.dlq)).toBe(0);
    // 1000 − 6×10 + 2×15 + 10 (REFUND) − 15 (ROLLBACK do WIN) = 965.00, independentemente da ordem.
    expect(await balancesOf(wallets.map((wallet) => wallet.walletId))).toEqual(Array(WALLETS).fill('965.00'));
    const duplicates = await sumMetric(
      cluster.byRole('consumer').map((instance) => instance.baseUrl),
      (url) => metricValue(url, 'inbox_duplicates_total'),
    );
    // Pelo menos as 120 cópias enviadas de propósito; pode haver mais: sob carga, uma mensagem cujo ack passa do
    // visibility timeout (3 s aqui) é reentregue depois do commit — e também cai na inbox, sem segundo efeito.
    expect(duplicates).toBeGreaterThanOrEqual(WALLETS * 6);
    await waitForOutboxDrained();
    await expectAllEventsPublished(queues.events);
    await assertFinalConsistency(
      urls[0] as string,
      wallets.map((wallet) => wallet.walletId),
    );
  }, 180_000);
});
