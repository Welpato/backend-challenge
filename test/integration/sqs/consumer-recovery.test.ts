import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { loadConfig } from '@/config/load-config';
import { CONSUMER_FAULT_EXIT_CODE } from '@/messaging/sqs/wager-consumer.worker';
import { appDb, closeDb, truncateAll } from '../../support/db';
import { assertLedgerInvariant } from '../../support/invariants';
import { metricValue } from '../../support/metrics';
import { createWagerQueues, deleteWagerQueues, queueDepth, sendEnvelope, type WagerQueues } from '../../support/sqs';
import { type AppProcess, spawnApp, waitFor } from '../../support/subprocess';
import { TcpProxy } from '../../support/tcp-proxy';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import { ledgerRows, openWallet, operation, walletBalance } from '../../support/wagering-http';
import { collectDlq, envelopeFor, inboxRows, transactionsOf, waitForStatus } from './sqs-test-kit';

/**
 * Falhas do consumidor SQS (F12) com PG e SQS reais: PostgreSQL inalcançável (proxy TCP cortado — os outros
 * testes continuam usando o banco), morte entre o commit e o ack (subprocesso com fault hook) e SIGTERM com
 * mensagens em andamento.
 */
let api: RunningTestApp;

const GRACEFUL_EXIT_CODES = [0, 143];

beforeAll(async () => {
  api = await startTestApp({ INSTANCE_ID: 'it-sqs-recovery-api' });
});

afterAll(async () => {
  await api.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

/** `DATABASE_URL` do `.env.test` apontando para o proxy. */
function databaseUrlThrough(proxyUrl: string): string {
  const url = new URL(loadConfig().database.url);
  url.port = new URL(proxyUrl).port;
  url.hostname = '127.0.0.1';
  return url.toString();
}

function pgProxy(): TcpProxy {
  const url = new URL(loadConfig().database.url);
  return new TcpProxy(url.hostname, Number(url.port));
}

function consumerProcess(queues: WagerQueues, instanceId: string, env: Record<string, string> = {}): AppProcess {
  return spawnApp({
    APP_ROLE: 'consumer',
    INSTANCE_ID: instanceId,
    SQS_WAIT_TIME_SECONDS: '1',
    ...queues.env,
    ...env,
  });
}

describe('SQS consumer — transient failures', () => {
  it('PostgreSQL down → the message comes back with backoff; PostgreSQL back → processed exactly once', async () => {
    const queues = await createWagerQueues('pg-down');
    const proxy = pgProxy();
    const proxyUrl = proxy.start();
    const consumer = await startTestApp({
      APP_ROLE: 'consumer',
      INSTANCE_ID: 'it-sqs-pg-down',
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_RETRY_BACKOFF_BASE_MS: '1000',
      DATABASE_URL: databaseUrlThrough(proxyUrl),
      ...queues.env,
    });
    try {
      const wallet = await openWallet(api.baseUrl, '100.00');
      proxy.cut();
      const bet = operation(wallet);
      await sendEnvelope(queues.queue, envelopeFor(bet));

      await waitFor(
        async () => (await metricValue(consumer.baseUrl, 'sqs_retries_total')) >= 2,
        20_000,
        'message retried with PostgreSQL down',
      );
      expect(await transactionsOf(wallet.walletId)).toHaveLength(0);
      expect(await queueDepth(queues.queue)).toBe(1);

      proxy.restore();
      await waitForStatus(bet, ['PROCESSED'], 20_000);
      await waitFor(async () => (await queueDepth(queues.queue)) === 0, 15_000, 'message acked');
      expect(await transactionsOf(wallet.walletId)).toHaveLength(1);
      expect(await ledgerRows(wallet.walletId)).toHaveLength(1);
      expect(await walletBalance(wallet.walletId)).toBe('75.00');
      expect(await queueDepth(queues.dlq)).toBe(0);
      await assertLedgerInvariant([wallet.walletId], { baseUrl: api.baseUrl });
    } finally {
      await consumer.close();
      proxy.stop();
      await deleteWagerQueues(queues);
    }
  }, 60_000);

  it('a failure that persists for maxReceiveCount (5) deliveries ends in the DLQ through the redrive', async () => {
    const queues = await createWagerQueues('redrive', { maxReceiveCount: 5 });
    const proxy = pgProxy();
    const proxyUrl = proxy.start();
    const consumer = await startTestApp({
      APP_ROLE: 'consumer',
      INSTANCE_ID: 'it-sqs-redrive',
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_RETRY_BACKOFF_BASE_MS: '1',
      SQS_RETRY_BACKOFF_MAX_MS: '1000',
      DATABASE_URL: databaseUrlThrough(proxyUrl),
      ...queues.env,
    });
    try {
      const wallet = await openWallet(api.baseUrl, '100.00');
      proxy.cut();
      const envelope = envelopeFor(operation(wallet), { messageId: 'msg-always-failing' });
      await sendEnvelope(queues.queue, envelope);

      const [entry] = await collectDlq(queues.dlq, 1, 40_000);
      // O redrive move a mensagem original (sem atributos do consumidor): o motivo está nos logs/métricas.
      expect(entry?.body).toBe(JSON.stringify(envelope));
      expect(entry?.failureReason).toBeUndefined();
      expect(await metricValue(consumer.baseUrl, 'sqs_retries_total')).toBeGreaterThanOrEqual(5);
      expect(await queueDepth(queues.queue)).toBe(0);
      expect(await transactionsOf(wallet.walletId)).toHaveLength(0);
    } finally {
      await consumer.close();
      proxy.stop();
      await deleteWagerQueues(queues);
    }
  }, 60_000);
});

describe('SQS consumer — crashes and shutdown', () => {
  it('consumer dies after the commit and before the ack → redelivery → no duplicated effect', async () => {
    const queues = await createWagerQueues('crash', { visibilityTimeoutSeconds: 2 });
    try {
      const wallet = await openWallet(api.baseUrl, '100.00');
      const bet = operation(wallet);
      await sendEnvelope(queues.queue, envelopeFor(bet, { messageId: 'msg-crash' }));

      const doomed = consumerProcess(queues, 'consumer-doomed', { FAULT_EXIT_AFTER_COMMIT: '1' });
      expect(await doomed.proc.exited, await doomed.output()).toBe(CONSUMER_FAULT_EXIT_CODE);
      await waitForStatus(bet, ['PROCESSED']);
      expect(await queueDepth(queues.queue)).toBe(1); // nunca houve ack

      const survivor = consumerProcess(queues, 'consumer-survivor');
      try {
        await waitFor(async () => (await queueDepth(queues.queue)) === 0, 20_000, 'redelivered message acked');
        expect(await metricValue(`http://127.0.0.1:${survivor.port}`, 'inbox_duplicates_total')).toBe(1);
      } finally {
        expect(GRACEFUL_EXIT_CODES).toContain(await survivor.terminate());
      }
      expect(await transactionsOf(wallet.walletId)).toHaveLength(1);
      expect(await ledgerRows(wallet.walletId)).toHaveLength(1);
      expect(await walletBalance(wallet.walletId)).toBe('75.00');
      expect(await inboxRows()).toEqual([expect.objectContaining({ message_id: 'msg-crash', processed: true })]);
      await assertLedgerInvariant([wallet.walletId], { baseUrl: api.baseUrl });
    } finally {
      await deleteWagerQueues(queues);
    }
  }, 60_000);

  it('SIGTERM with messages in flight → finished or returned (readiness 503 meanwhile); a restart processes the rest', async () => {
    const queues = await createWagerQueues('sigterm');
    const blocked = await openWallet(api.baseUrl, '1000.00');
    const free = await openWallet(api.baseUrl, '1000.00');
    const blockedOps = Array.from({ length: 3 }, () =>
      operation(blocked, { money: { amount: '10.00', currency: 'BRL' } }),
    );
    const freeOps = Array.from({ length: 3 }, () => operation(free, { money: { amount: '10.00', currency: 'BRL' } }));

    // Segura o lock da wallet `blocked` numa transação do teste: as mensagens dela ficam presas em andamento.
    let releaseLock: () => void = () => {};
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockTaken: () => void = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const holder = appDb().begin(async (sql) => {
      await sql`select set_config('lock_timeout', '0', true)`;
      await sql`select id from wallets where id = ${blocked.walletId} for update`;
      lockTaken();
      await lockReleased;
    });
    await lockHeld;

    // lock_timeout longo: a mensagem presa continua em andamento quando o prazo de 1,5 s vence (é devolvida).
    // O ORM só fecha quando essa transação termina (lock timeout), então a saída leva ~8 s.
    const consumer = consumerProcess(queues, 'consumer-sigterm', {
      SHUTDOWN_GRACE_MS: '1500',
      DB_LOCK_TIMEOUT_MS: '8000',
    });
    const baseUrl = `http://127.0.0.1:${consumer.port}`;
    let restarted: AppProcess | undefined;
    try {
      await waitFor(
        async () => (await fetch(`${baseUrl}/health/ready`).catch(() => undefined))?.status === 200,
        15_000,
        'consumer ready',
      );
      for (const input of [...blockedOps, ...freeOps]) {
        await sendEnvelope(queues.queue, envelopeFor(input));
      }
      for (const input of freeOps) {
        await waitForStatus(input, ['PROCESSED']);
      }

      consumer.proc.kill('SIGTERM');
      let sawNotReady = false;
      await waitFor(
        async () => {
          const response = await fetch(`${baseUrl}/health/ready`).catch(() => undefined);
          sawNotReady ||= response?.status === 503;
          return sawNotReady || response === undefined;
        },
        5_000,
        'readiness 503 during shutdown',
        20,
      );
      expect(sawNotReady).toBe(true);
      expect(GRACEFUL_EXIT_CODES, await consumer.output()).toContain(await consumer.proc.exited);
      expect(await consumer.output()).toContain('Returned unfinished messages to the queue');
      // Nada da wallet bloqueada foi gravado; as mensagens voltaram para a fila (nenhuma perdida, nenhuma na DLQ).
      expect(await transactionsOf(blocked.walletId)).toHaveLength(0);
      expect(await queueDepth(queues.queue)).toBe(blockedOps.length);

      releaseLock();
      await holder;
      restarted = consumerProcess(queues, 'consumer-restarted');
      for (const input of blockedOps) {
        await waitForStatus(input, ['PROCESSED'], 20_000);
      }
      await waitFor(async () => (await queueDepth(queues.queue)) === 0, 15_000, 'all messages acked');
      expect(await queueDepth(queues.dlq)).toBe(0);
      expect(await walletBalance(blocked.walletId)).toBe('970.00');
      expect(await walletBalance(free.walletId)).toBe('970.00');
      await assertLedgerInvariant([blocked.walletId, free.walletId], { baseUrl: api.baseUrl });
    } finally {
      releaseLock();
      await holder.catch(() => undefined);
      await consumer.terminate();
      await restarted?.terminate();
      await deleteWagerQueues(queues);
    }
  }, 90_000);
});
