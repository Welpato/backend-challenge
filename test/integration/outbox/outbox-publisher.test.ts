import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { OUTBOX_REPOSITORY, type OutboxRepository } from '@/messaging/outbox/application/outbox.repository.port';
import { OutboxMessage } from '@/messaging/outbox/outbox-message';
import { OutboxPublisherWorker } from '@/messaging/outbox/outbox-publisher.worker';
import { newUuidV7 } from '@/shared/ids';
import { Money } from '@/shared/money/money';
import { UnitOfWork } from '@/shared/persistence/unit-of-work';
import { WalletBalanceChanged } from '@/wallet/domain/events/wallet-balance-changed';
import { Wallet } from '@/wallet/domain/wallet';
import { closeDb, truncateAll } from '../../support/db';
import { latch } from '../../support/persistence';
import {
  createIsolatedQueue,
  DedupByEventIdConsumer,
  deleteQueue,
  drainQueue,
  envelopeOf,
  type IsolatedQueue,
  receive,
  releaseForRedelivery,
} from '../../support/sqs';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import { outboxCounts, outboxIds, produceEvents } from './outbox-test-kit';

let api: RunningTestApp;
let publisherApp: RunningTestApp;
let worker: OutboxPublisherWorker;
let queue: IsolatedQueue;

beforeAll(async () => {
  api = await startTestApp({ INSTANCE_ID: 'it-outbox-api' });
});

afterAll(async () => {
  await api.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

/** Publisher real (papel `outbox`) numa fila isolada, com o loop parado: o teste dirige com `runOnce`. */
async function startPublisher(): Promise<void> {
  queue = await createIsolatedQueue('outbox');
  publisherApp = await startTestApp({
    APP_ROLE: 'outbox',
    INSTANCE_ID: 'it-outbox-publisher',
    SQS_EVENTS_QUEUE_NAME: queue.name,
    OUTBOX_POLL_INTERVAL_MS: '60000',
  });
  worker = publisherApp.app.get(OutboxPublisherWorker);
  await worker.stop();
}

async function stopPublisher(): Promise<void> {
  await publisherApp.close();
  await deleteQueue(queue);
}

/** Evento de verdade (`WalletBalanceChanged` de uma abertura), sem tocar em outras tabelas. */
function sampleMessage(): OutboxMessage {
  const at = new Date();
  const { wallet, openingEntry } = Wallet.open({
    id: newUuidV7(),
    playerId: 'player-outbox',
    initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    openingTransactionId: newUuidV7(),
    at,
  });
  if (openingEntry === undefined) {
    throw new Error('fixture');
  }
  const event = WalletBalanceChanged.from(wallet, openingEntry, {
    correlationId: 'corr-outbox',
    occurredAt: at,
    eventIdFactory: newUuidV7,
  });
  return OutboxMessage.enqueue(event, at);
}

describe('outbox publisher (single instance)', () => {
  beforeEach(startPublisher);

  it('publishes an event only after its transaction commits; an aborted transaction never produces one', async () => {
    const outbox = api.app.get<OutboxRepository>(OUTBOX_REPOSITORY);
    const uow = api.app.get(UnitOfWork);
    try {
      const committed = sampleMessage();
      const inserted = latch();
      const release = latch();
      const businessTx = uow.run(async () => {
        await outbox.enqueue([committed]);
        inserted.open();
        await release.promise;
      });
      await inserted.promise;

      expect(await worker.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 });
      expect(await receive(queue)).toEqual([]);

      release.open();
      await businessTx;
      expect(await worker.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });
      const delivered = await drainQueue(queue);
      expect(delivered.map((message) => envelopeOf(message).eventId)).toEqual([committed.id]);

      const aborted = sampleMessage();
      const failure = await uow
        .run(async () => {
          await outbox.enqueue([aborted]);
          throw new Error('business rule failed after enqueue');
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(await worker.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 });
      expect(await drainQueue(queue)).toEqual([]);
      expect(await outboxCounts()).toMatchObject({ total: 1, published: 1 });
    } finally {
      await stopPublisher();
    }
  });

  it('sends the envelope with group = aggregateId, deduplication id = eventId and the attributes', async () => {
    try {
      await produceEvents(api.baseUrl, 1, 1);
      expect(await worker.runOnce()).toMatchObject({ claimed: 4, published: 4 });

      const messages = await drainQueue(queue);
      expect(messages).toHaveLength(4);
      for (const message of messages) {
        const envelope = envelopeOf(message);
        expect(message.Attributes?.MessageGroupId).toBe(envelope.aggregateId);
        expect(message.Attributes?.MessageDeduplicationId).toBe(envelope.eventId);
        expect(message.MessageAttributes?.eventType?.StringValue).toBe(envelope.eventType);
        expect(message.MessageAttributes?.eventVersion?.StringValue).toBe(String(envelope.version));
        expect(message.MessageAttributes?.correlationId?.StringValue).toBe(envelope.correlationId);
        expect(typeof (envelope.data as { money?: { amount?: unknown } }).money?.amount).toBe('string');
      }
      expect(new Set(messages.map((message) => envelopeOf(message).eventId))).toEqual(new Set(await outboxIds()));
      expect(await outboxCounts()).toMatchObject({ pending: 0 });

      const metrics = await (await fetch(`${publisherApp.baseUrl}/metrics`)).text();
      expect(metrics).toMatch(/outbox_published_total\{[^}]*\} 4/);
      expect(metrics).toMatch(/outbox_pending\{[^}]*\} 0/);
      expect(metrics).toContain('outbox_lag_seconds{');
      expect(metrics).toContain('outbox_messages_over_retry_threshold{');
    } finally {
      await stopPublisher();
    }
  });

  it('a duplicated delivery is harmless for a consumer that deduplicates by eventId', async () => {
    try {
      await produceEvents(api.baseUrl, 2, 2);
      await worker.runOnce();

      // At-least-once de verdade: recebe sem apagar, devolve à fila e recebe de novo.
      const firstDelivery = await receive(queue);
      await releaseForRedelivery(queue, firstDelivery);
      const everything = [...firstDelivery, ...(await drainQueue(queue))];
      const consumer = new DedupByEventIdConsumer();
      consumer.consume(everything);

      expect(firstDelivery.length).toBeGreaterThan(0);
      expect(consumer.duplicates).toBe(firstDelivery.length);
      expect(consumer.applied).toBe((await outboxIds()).length);
      expect([...consumer.balances.values()].map((balance) => balance.amount).sort()).toEqual(['998.00', '998.00']);
    } finally {
      await stopPublisher();
    }
  });
});
