import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { appDb, closeDb, truncateAll } from '../../support/db';
import {
  createIsolatedQueue,
  createWagerQueues,
  deleteQueue,
  deleteWagerQueues,
  sendEnvelope,
  wagerEnvelope,
} from '../../support/sqs';
import { type AppProcess, spawnApp, waitFor } from '../../support/subprocess';
import { openWallet, operation, submit, walletBalance } from '../../support/wagering-http';

/**
 * Logs estruturados e redaction (F14), com a app real num processo à parte (`APP_ROLE=all`, `LOG_LEVEL=debug`,
 * o nível mais verboso): uma BET de 25.00 por HTTP e outra pela fila, numa wallet de 1000.00. Nenhuma linha pode
 * conter valor, saldo, corpo ou payload; as linhas de processamento têm todos os identificadores de §10.
 */
let app: AppProcess;
let lines: Record<string, unknown>[];

const VALUES = ['25.00', '1000.00', '975.00', '950.00'];

beforeAll(async () => {
  await truncateAll();
  const queues = await createWagerQueues('obs-logs');
  const events = await createIsolatedQueue('obs-logs-events');
  app = spawnApp({
    APP_ROLE: 'all',
    INSTANCE_ID: 'it-logs-all',
    LOG_LEVEL: 'debug',
    SQS_WAIT_TIME_SECONDS: '1',
    OUTBOX_POLL_INTERVAL_MS: '50',
    SQS_EVENTS_QUEUE_NAME: events.name,
    ...queues.env,
  });
  const baseUrl = `http://127.0.0.1:${app.port}`;
  try {
    await waitFor(
      async () => (await fetch(`${baseUrl}/health/ready`).catch(() => undefined))?.status === 200,
      20_000,
      'app ready',
    );
    const wallet = await openWallet(baseUrl, '1000.00');
    const httpBet = operation(wallet);
    expect((await submit(baseUrl, httpBet, undefined, { 'x-correlation-id': 'corr-logs-http' })).status).toBe(201);
    const sqsBet = operation(wallet);
    await sendEnvelope(
      queues.queue,
      wagerEnvelope({
        messageId: 'msg-logs-1',
        data: { ...sqsBet, idempotencyKey: `${sqsBet.providerId}:${sqsBet.externalTransactionId}` },
      }),
    );
    await waitFor(async () => (await walletBalance(wallet.walletId)) === '950.00', 15_000, 'SQS BET processed');
    // Espera o publisher publicar os eventos (o payload deles tem dinheiro e não pode aparecer no log).
    await waitFor(
      async () => {
        const [row] = await appDb()`select count(*)::int as n from outbox_messages where published_at is null`;
        return (row as { n: number }).n === 0;
      },
      15_000,
      'outbox published',
    );
  } finally {
    await app.terminate();
    await Promise.all([deleteWagerQueues(queues), deleteQueue(events)]);
  }
  lines = (await app.output())
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}, 60_000);

afterAll(async () => {
  await closeDb();
});

describe('structured logs', () => {
  it('no log line carries an amount, a balance, a request body or an event payload', () => {
    expect(lines.length).toBeGreaterThan(20);
    const raw = lines.map((line) => JSON.stringify(line));
    for (const value of VALUES) {
      expect(raw.filter((line) => line.includes(value))).toEqual([]);
    }
    expect(raw.filter((line) => /"(money|amount|balance|payload|initialBalance)"\s*:\s*[{"]/.test(line))).toEqual([]);
  });

  it('the HTTP processing line has every identifier of §10 and the duration', () => {
    const line = lines.find((entry) => entry.msg === 'Wager transaction processed' && entry.source === 'http');
    expect(line).toMatchObject({
      level: 'info',
      instanceId: 'it-logs-all',
      correlationId: 'corr-logs-http',
      transactionId: expect.any(String),
      walletId: expect.any(String),
      providerId: 'provider-a',
      kind: 'BET',
      status: 'PROCESSED',
      durationMs: expect.any(Number),
    });
  });

  it('the SQS lines carry messageId and causationId; the request log of HTTP keeps the correlation id', () => {
    for (const msg of ['Wager transaction processed', 'Message processed']) {
      const line = lines.find((entry) => entry.msg === msg && entry.messageId === 'msg-logs-1');
      expect(line, msg).toMatchObject({
        instanceId: 'it-logs-all',
        correlationId: 'msg-logs-1',
        causationId: 'msg-logs-1',
        messageId: 'msg-logs-1',
        transactionId: expect.any(String),
        walletId: expect.any(String),
        providerId: 'provider-a',
        kind: 'BET',
        status: 'PROCESSED',
        durationMs: expect.any(Number),
      });
    }
    const request = lines.find(
      (entry) => entry.msg === 'request completed' && entry.correlationId === 'corr-logs-http',
    );
    expect(request).toBeDefined();
  });

  it('the outbox publisher logs its batches with the duration and no event content', () => {
    const batch = lines.find((entry) => entry.msg === 'Outbox batch processed');
    expect(batch).toMatchObject({
      instanceId: 'it-logs-all',
      claimed: expect.any(Number),
      durationMs: expect.any(Number),
    });
  });
});
