import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { loadConfig } from '@/config/load-config';
import { FAULT_EXIT_CODE, OutboxPublisherWorker } from '@/messaging/outbox/outbox-publisher.worker';
import { closeDb, truncateAll } from '../../support/db';
import { createIsolatedQueue, DedupByEventIdConsumer, deleteQueue, drainQueue, envelopeOf } from '../../support/sqs';
import { spawnApp, waitFor } from '../../support/subprocess';
import { hostPortOf, TcpProxy } from '../../support/tcp-proxy';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import { outboxCounts, produceEvents } from './outbox-test-kit';

/**
 * Recuperação do publisher com processos e SQS reais: morte entre a publicação e o commit, publishers
 * concorrentes em processos separados e SQS inalcançável.
 */
let api: RunningTestApp;

/**
 * SIGTERM: o Nest fecha a aplicação (hooks de shutdown, o publisher termina o lote) e depois reenvia o sinal a si
 * mesmo — o Bun reporta 143 (128 + 15). 0 também é aceito.
 */
const GRACEFUL_EXIT_CODES = [0, 143];

beforeAll(async () => {
  api = await startTestApp({ INSTANCE_ID: 'it-outbox-recovery-api' });
});

afterAll(async () => {
  await api.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('outbox publisher recovery', () => {
  it('commit → publisher dies after publishing and before its commit → another instance publishes; nothing is lost', async () => {
    const queue = await createIsolatedQueue('crash');
    try {
      const ids = await produceEvents(api.baseUrl, 3, 1);
      expect(ids).toHaveLength(12);

      const doomed = spawnApp({
        APP_ROLE: 'outbox',
        INSTANCE_ID: 'outbox-doomed',
        SQS_EVENTS_QUEUE_NAME: queue.name,
        FAULT_EXIT_AFTER_PUBLISH: '1',
        OUTBOX_BATCH_SIZE: '5',
      });
      const exitCode = await doomed.proc.exited;
      expect(exitCode, await doomed.output()).toBe(FAULT_EXIT_CODE);
      // O lote foi publicado, mas o commit nunca aconteceu: tudo continua pendente no banco.
      expect(await outboxCounts()).toMatchObject({ total: 12, published: 0 });

      const survivor = spawnApp({
        APP_ROLE: 'outbox',
        INSTANCE_ID: 'outbox-survivor',
        SQS_EVENTS_QUEUE_NAME: queue.name,
        OUTBOX_POLL_INTERVAL_MS: '50',
      });
      try {
        await waitFor(async () => (await outboxCounts()).published === 12, 20_000, 'all events published');
      } finally {
        expect(GRACEFUL_EXIT_CODES).toContain(await survivor.terminate());
      }

      const delivered = await drainQueue(queue);
      const consumer = new DedupByEventIdConsumer();
      consumer.consume(delivered);
      expect(consumer.applied).toBe(12);
      expect(new Set(delivered.map((message) => envelopeOf(message).eventId))).toEqual(new Set(ids));
    } finally {
      await deleteQueue(queue);
    }
  }, 60_000);

  it('two publisher processes over 500 events publish all of them; any duplicate carries the same eventId', async () => {
    const queue = await createIsolatedQueue('pair');
    try {
      const ids = await produceEvents(api.baseUrl, 10, 24);
      expect(ids).toHaveLength(500);

      const publishers = ['outbox-a', 'outbox-b'].map((instance) =>
        spawnApp({
          APP_ROLE: 'outbox',
          INSTANCE_ID: instance,
          SQS_EVENTS_QUEUE_NAME: queue.name,
          OUTBOX_POLL_INTERVAL_MS: '20',
          OUTBOX_BATCH_SIZE: '20',
        }),
      );
      try {
        await waitFor(async () => (await outboxCounts()).published === 500, 60_000, '500 events published');
      } finally {
        const codes = await Promise.all(publishers.map((publisher) => publisher.terminate()));
        for (const code of codes) {
          expect(GRACEFUL_EXIT_CODES).toContain(code);
        }
      }

      const delivered = await drainQueue(queue);
      const deliveredIds = delivered.map((message) => envelopeOf(message).eventId);
      expect(new Set(deliveredIds)).toEqual(new Set(ids));
      const consumer = new DedupByEventIdConsumer();
      consumer.consume(delivered);
      expect(consumer.applied).toBe(500);
      expect(consumer.applied + consumer.duplicates).toBe(delivered.length);
    } finally {
      await deleteQueue(queue);
    }
  }, 120_000);

  it('with SQS unreachable attempts grow and nothing is lost; when it comes back everything is published', async () => {
    const queue = await createIsolatedQueue('outage');
    const endpoint = loadConfig().sqs.endpoint;
    if (endpoint === undefined) {
      throw new Error('SQS_ENDPOINT is required for this test');
    }
    const target = hostPortOf(endpoint);
    const proxy = new TcpProxy(target.host, target.port);
    const proxyUrl = proxy.start();
    const publisher = await startTestApp({
      APP_ROLE: 'outbox',
      INSTANCE_ID: 'it-outbox-outage',
      SQS_ENDPOINT: proxyUrl,
      SQS_EVENTS_QUEUE_NAME: queue.name,
      OUTBOX_POLL_INTERVAL_MS: '60000',
    });
    const worker = publisher.app.get(OutboxPublisherWorker);
    await worker.stop();
    try {
      const ids = await produceEvents(api.baseUrl, 2, 1);
      proxy.cut();

      expect(await worker.runOnce()).toMatchObject({ claimed: 8, published: 0, failed: 8 });
      expect(await outboxCounts()).toMatchObject({ total: 8, pending: 8, maxAttempts: 1 });
      await Bun.sleep(2_000);
      expect(await worker.runOnce()).toMatchObject({ claimed: 8, failed: 8 });
      expect(await outboxCounts()).toMatchObject({ pending: 8, maxAttempts: 2 });
      const metrics = await (await fetch(`${publisher.baseUrl}/metrics`)).text();
      expect(metrics).toMatch(/outbox_publish_failures_total\{[^}]*\} 16/);

      proxy.restore();
      await waitFor(
        async () => (await worker.runOnce()).published > 0 || (await outboxCounts()).pending === 0,
        10_000,
        'publication after SQS is back',
        250,
      );
      await waitFor(
        async () => {
          await worker.runOnce();
          return (await outboxCounts()).pending === 0;
        },
        10_000,
        'every event published',
        250,
      );

      const delivered = await drainQueue(queue);
      expect(new Set(delivered.map((message) => envelopeOf(message).eventId))).toEqual(new Set(ids));
    } finally {
      await publisher.close();
      proxy.stop();
      await deleteQueue(queue);
    }
  }, 60_000);
});
