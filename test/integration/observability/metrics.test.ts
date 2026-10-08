import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { OutboxPublisherWorker } from '@/messaging/outbox/outbox-publisher.worker';
import { PendingReferenceWorker } from '@/messaging/reprocessor/pending-reference.worker';
import { appDb, closeDb, truncateAll } from '../../support/db';
import { metricValue } from '../../support/metrics';
import {
  createIsolatedQueue,
  createWagerQueues,
  deleteQueue,
  deleteWagerQueues,
  type IsolatedQueue,
  sendEnvelope,
  sendRaw,
  type WagerQueues,
  wagerEnvelope,
} from '../../support/sqs';
import { waitFor } from '../../support/subprocess';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import { expectErrorCode, type OpenedWallet, openWallet, operation, submit } from '../../support/wagering-http';

/**
 * Métricas de §10 (F14) lidas do `/metrics` da app real em cada cenário que deve movê-las. As de SQS também são
 * conferidas nos testes do consumidor (F12) e a de reconciliação nos da wallet (F08).
 */
let api: RunningTestApp;
let wallet: OpenedWallet;

beforeAll(async () => {
  api = await startTestApp({ INSTANCE_ID: 'it-metrics-api', DB_LOCK_TIMEOUT_MS: '300' });
});

afterAll(async () => {
  await api.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
  wallet = await openWallet(api.baseUrl, '100.00');
});

describe('processing metrics (HTTP)', () => {
  it('counts transactions by kind/status/failure code/source, replays, duration and lock wait', async () => {
    const processed = { kind: 'BET', status: 'PROCESSED', failure_code: '', source: 'http' };
    const rejected = { kind: 'BET', status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', source: 'http' };
    const before = {
      processed: await metricValue(api.baseUrl, 'wager_transactions_total', processed),
      rejected: await metricValue(api.baseUrl, 'wager_transactions_total', rejected),
      replays: await metricValue(api.baseUrl, 'idempotent_replays_total', { source: 'http' }),
      durations: await metricValue(api.baseUrl, 'processing_duration_seconds_count', { source: 'http', kind: 'BET' }),
      lockWaits: await metricValue(api.baseUrl, 'wallet_lock_wait_seconds_count'),
    };

    const bet = operation(wallet);
    expect((await submit(api.baseUrl, bet)).status).toBe(201);
    expect((await submit(api.baseUrl, bet)).status).toBe(200);
    expect(
      (await submit(api.baseUrl, operation(wallet, { money: { amount: '500.00', currency: 'BRL' } }))).status,
    ).toBe(422);

    expect(await metricValue(api.baseUrl, 'wager_transactions_total', processed)).toBe(before.processed + 1);
    expect(await metricValue(api.baseUrl, 'wager_transactions_total', rejected)).toBe(before.rejected + 1);
    expect(await metricValue(api.baseUrl, 'idempotent_replays_total', { source: 'http' })).toBe(before.replays + 1);
    expect(await metricValue(api.baseUrl, 'processing_duration_seconds_count', { source: 'http', kind: 'BET' })).toBe(
      before.durations + 3,
    );
    // O replay não chega ao lock da wallet; a BET nova e a rejeitada, sim.
    expect(await metricValue(api.baseUrl, 'wallet_lock_wait_seconds_count')).toBe(before.lockWaits + 2);
  });

  it('every series carries the default instance and role labels', async () => {
    const text = await (await fetch(`${api.baseUrl}/metrics`)).text();
    expect(text).toMatch(/wallet_lock_wait_seconds_bucket\{le="0\.001",instance="it-metrics-api",role="api"\}/);
    expect(text).toContain('# TYPE wager_transactions_total counter');
    expect(text).toContain('# TYPE processing_duration_seconds histogram');
  });

  it('a wallet lock held elsewhere → 503 and wallet_lock_conflicts_total{type="timeout"} + 1', async () => {
    const before = await metricValue(api.baseUrl, 'wallet_lock_conflicts_total', { type: 'timeout' });
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const holder = appDb().begin(async (sql) => {
      await sql`select id from wallets where id = ${wallet.walletId} for update`;
      held.resolve();
      await release.promise;
    });
    await held.promise;
    try {
      expectErrorCode(await submit(api.baseUrl, operation(wallet)), 503, 'TRANSIENT_UNAVAILABLE');
    } finally {
      release.resolve();
      await holder;
    }
    expect(await metricValue(api.baseUrl, 'wallet_lock_conflicts_total', { type: 'timeout' })).toBe(before + 1);
  });
});

describe('database gauges (periodic collection, never on scrape)', () => {
  let queue: IsolatedQueue;

  beforeAll(async () => {
    queue = await createIsolatedQueue('obs-events');
  });

  afterAll(async () => {
    await deleteQueue(queue);
  });

  it('outbox_pending/outbox_lag_seconds follow the outbox at the collection interval; publishing moves the counters', async () => {
    const publisher = await startTestApp({
      APP_ROLE: 'outbox',
      INSTANCE_ID: 'it-metrics-outbox',
      SQS_EVENTS_QUEUE_NAME: queue.name,
      METRICS_COLLECT_INTERVAL_MS: '100',
    });
    const worker = publisher.app.get(OutboxPublisherWorker);
    await worker.stop();
    try {
      // O loop publicou os eventos da abertura antes de parar; os da BET ficam pendentes.
      const publishedAtStart = await metricValue(publisher.baseUrl, 'outbox_published_total');
      await submit(api.baseUrl, operation(wallet));
      const [row] = await appDb()`select count(*)::int as n from outbox_messages where published_at is null`;
      const pending = (row as { n: number }).n;
      expect(pending).toBe(2);
      await waitFor(
        async () => (await metricValue(publisher.baseUrl, 'outbox_pending')) === pending,
        5_000,
        'outbox_pending = 2',
      );
      await waitFor(async () => (await metricValue(publisher.baseUrl, 'outbox_lag_seconds')) > 0, 5_000, 'lag > 0');

      expect(await worker.runOnce()).toMatchObject({ published: pending });
      expect(await metricValue(publisher.baseUrl, 'outbox_published_total')).toBe(publishedAtStart + pending);
      await waitFor(
        async () =>
          (await metricValue(publisher.baseUrl, 'outbox_pending')) === 0 &&
          (await metricValue(publisher.baseUrl, 'outbox_lag_seconds')) === 0,
        5_000,
        'outbox gauges back to 0',
      );
    } finally {
      await publisher.close();
    }
  }, 30_000);

  it('a scrape does not query the database: with a long interval the gauge keeps the collected value', async () => {
    const reprocessor = await startTestApp({
      APP_ROLE: 'reprocessor',
      INSTANCE_ID: 'it-metrics-reprocessor',
      METRICS_COLLECT_INTERVAL_MS: '600000',
    });
    await reprocessor.app.get(PendingReferenceWorker).stop();
    try {
      // A primeira coleta acontece na subida (0 pendências).
      await waitFor(async () => (await fetch(`${reprocessor.baseUrl}/metrics`)).ok, 5_000, 'metrics endpoint up');
      const refund = operation(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'missing-bet' });
      expect((await submit(api.baseUrl, refund)).status).toBe(202);
      for (let i = 0; i < 3; i += 1) {
        expect(await metricValue(reprocessor.baseUrl, 'pending_references')).toBe(0);
      }
    } finally {
      await reprocessor.close();
    }
  });

  it('pending_references reflects PENDING_REFERENCE transactions at the collection interval', async () => {
    const reprocessor = await startTestApp({
      APP_ROLE: 'reprocessor',
      INSTANCE_ID: 'it-metrics-reprocessor-2',
      METRICS_COLLECT_INTERVAL_MS: '100',
    });
    await reprocessor.app.get(PendingReferenceWorker).stop();
    try {
      for (const reference of ['missing-1', 'missing-2']) {
        const refund = operation(wallet, { kind: 'REFUND', referenceExternalTransactionId: reference });
        expect((await submit(api.baseUrl, refund)).status).toBe(202);
      }
      await waitFor(
        async () => (await metricValue(reprocessor.baseUrl, 'pending_references')) === 2,
        5_000,
        'pending_references = 2',
      );
    } finally {
      await reprocessor.close();
    }
  });
});

describe('consumer metrics', () => {
  let queues: WagerQueues;
  let consumer: RunningTestApp;

  beforeAll(async () => {
    queues = await createWagerQueues('obs-consumer');
    consumer = await startTestApp({
      APP_ROLE: 'consumer',
      INSTANCE_ID: 'it-metrics-consumer',
      SQS_WAIT_TIME_SECONDS: '1',
      ...queues.env,
    });
  });

  afterAll(async () => {
    await consumer.close();
    await deleteWagerQueues(queues);
  });

  it('counts the SQS transaction, the inbox duplicate and the DLQ message by reason', async () => {
    const bet = operation(wallet);
    const envelope = wagerEnvelope({
      messageId: 'msg-metrics-1',
      data: { ...bet, idempotencyKey: `${bet.providerId}:${bet.externalTransactionId}` },
    });
    await sendEnvelope(queues.queue, envelope);
    await sendEnvelope(queues.queue, envelope);
    await sendRaw(queues.queue, '{broken', { groupId: 'broken' });

    await waitFor(
      async () =>
        (await metricValue(consumer.baseUrl, 'inbox_duplicates_total')) === 1 &&
        (await metricValue(consumer.baseUrl, 'sqs_dlq_messages_total', { reason: 'INVALID_ENVELOPE' })) === 1,
      15_000,
      'consumer metrics',
    );
    expect(
      await metricValue(consumer.baseUrl, 'wager_transactions_total', {
        kind: 'BET',
        status: 'PROCESSED',
        source: 'sqs',
      }),
    ).toBe(1);
    expect(await metricValue(consumer.baseUrl, 'processing_duration_seconds_count', { source: 'sqs' })).toBe(2);
    expect(await metricValue(consumer.baseUrl, 'sqs_retries_total')).toBe(0);
  }, 30_000);
});
