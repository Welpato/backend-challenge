import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { WAGER_CONSUMER_NAME } from '@/messaging/sqs/wager-consumer.worker';
import { closeDb, truncateAll } from '../../support/db';
import { assertLedgerInvariant } from '../../support/invariants';
import { metricValue } from '../../support/metrics';
import {
  createWagerQueues,
  deleteWagerQueues,
  queueDepth,
  sendEnvelope,
  sendRaw,
  type WagerQueues,
  wagerEnvelope,
} from '../../support/sqs';
import { waitFor } from '../../support/subprocess';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import {
  ledgerRows,
  type OpenedWallet,
  openWallet,
  operation,
  outboxFor,
  submit,
  walletBalance,
} from '../../support/wagering-http';
import { collectDlq, envelopeFor, inboxRows, transactionsOf, waitForStatus } from './sqs-test-kit';

/**
 * Consumidor SQS (F12) com PostgreSQL e SQS reais: a API abre wallets e serve de comparação; o consumidor roda
 * como outra instância da app (papel `consumer`) lendo um par de filas isolado (entrada + DLQ com redrive).
 */
let api: RunningTestApp;
let consumer: RunningTestApp;
let queues: WagerQueues;
let wallet: OpenedWallet;

beforeAll(async () => {
  queues = await createWagerQueues('consumer');
  api = await startTestApp({ INSTANCE_ID: 'it-sqs-api' });
  consumer = await startTestApp({
    APP_ROLE: 'consumer',
    INSTANCE_ID: 'it-sqs-consumer',
    SQS_WAIT_TIME_SECONDS: '1',
    ...queues.env,
  });
});

afterAll(async () => {
  await consumer.close();
  await api.close();
  await deleteWagerQueues(queues);
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
  wallet = await openWallet(api.baseUrl, '100.00');
});

async function waitForEmptyQueue(): Promise<void> {
  await waitFor(async () => (await queueDepth(queues.queue)) === 0, 15_000, 'input queue drained (acked)');
}

describe('SQS consumer — processing', () => {
  it('processes a BET from the queue with the same effects as HTTP, records the inbox and acks', async () => {
    const bet = operation(wallet);
    await sendEnvelope(queues.queue, envelopeFor(bet, { messageId: 'msg-bet-1' }));

    const row = await waitForStatus(bet, ['PROCESSED']);
    await waitForEmptyQueue();
    expect(row.correlation_id).toBe('msg-bet-1');
    expect(await walletBalance(wallet.walletId)).toBe('75.00');
    expect(await ledgerRows(wallet.walletId)).toEqual([
      expect.objectContaining({ transaction_id: row.id, direction: 'DEBIT' }),
    ]);
    expect(await inboxRows()).toEqual([
      { consumer_name: WAGER_CONSUMER_NAME, message_id: 'msg-bet-1', processed: true },
    ]);
    const events = await outboxFor(row.id);
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    for (const event of events) {
      expect(event.payload.correlationId).toBe('msg-bet-1');
      expect(event.payload.causationId).toBe('msg-bet-1');
    }

    // A mesma operação por HTTP (mesma key) é replay do que a fila gravou.
    const replay = await submit(api.baseUrl, bet);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ transactionId: row.id, idempotentReplay: true, balance: { amount: '75.00' } });
    await assertLedgerInvariant([wallet.walletId], { baseUrl: api.baseUrl });
  });

  it('uses the correlationId message attribute when present', async () => {
    const bet = operation(wallet);
    await sendEnvelope(queues.queue, envelopeFor(bet), { correlationId: 'corr-from-producer' });
    const row = await waitForStatus(bet, ['PROCESSED']);
    expect(row.correlation_id).toBe('corr-from-producer');
  });

  it('same message delivered twice (same messageId, different dedup id) → one effect, two acks, one inbox duplicate', async () => {
    const before = await metricValue(consumer.baseUrl, 'inbox_duplicates_total');
    const bet = operation(wallet);
    const envelope = envelopeFor(bet, { messageId: 'msg-dup-1' });
    await sendEnvelope(queues.queue, envelope);
    await sendEnvelope(queues.queue, envelope);

    await waitFor(
      async () => (await metricValue(consumer.baseUrl, 'inbox_duplicates_total')) === before + 1,
      15_000,
      'inbox duplicate counted',
    );
    await waitForEmptyQueue();
    expect(await transactionsOf(wallet.walletId)).toHaveLength(1);
    expect(await ledgerRows(wallet.walletId)).toHaveLength(1);
    expect(await walletBalance(wallet.walletId)).toBe('75.00');
    expect(await inboxRows()).toHaveLength(1);
    await assertLedgerInvariant([wallet.walletId], { baseUrl: api.baseUrl });
  });

  it('different messages with the same idempotencyKey → replay through the use case (one effect, two inbox rows)', async () => {
    const bet = operation(wallet);
    await sendEnvelope(queues.queue, envelopeFor(bet, { messageId: 'msg-a' }));
    await sendEnvelope(queues.queue, envelopeFor(bet, { messageId: 'msg-b' }));

    await waitFor(async () => (await inboxRows()).length === 2, 15_000, 'two inbox rows');
    await waitForEmptyQueue();
    expect((await inboxRows()).every((row) => row.processed)).toBe(true);
    expect(await transactionsOf(wallet.walletId)).toHaveLength(1);
    expect(await ledgerRows(wallet.walletId)).toHaveLength(1);
    expect(await walletBalance(wallet.walletId)).toBe('75.00');
  });

  it('same operation first via HTTP, then via the queue → a single effect', async () => {
    const bet = operation(wallet);
    expect((await submit(api.baseUrl, bet)).status).toBe(201);
    await sendEnvelope(queues.queue, envelopeFor(bet, { messageId: 'msg-after-http' }));

    await waitFor(async () => (await inboxRows()).length === 1, 15_000, 'message consumed');
    await waitForEmptyQueue();
    expect(await transactionsOf(wallet.walletId)).toHaveLength(1);
    expect(await ledgerRows(wallet.walletId)).toHaveLength(1);
    expect(await walletBalance(wallet.walletId)).toBe('75.00');
  });

  it('business rejection (insufficient funds) → REJECTED, acked, nothing in the DLQ', async () => {
    const bet = operation(wallet, { money: { amount: '150.00', currency: 'BRL' } });
    await sendEnvelope(queues.queue, envelopeFor(bet));

    const row = await waitForStatus(bet, ['REJECTED']);
    expect(row.failure_code).toBe('INSUFFICIENT_FUNDS');
    await waitForEmptyQueue();
    expect(await queueDepth(queues.dlq)).toBe(0);
    expect(await walletBalance(wallet.walletId)).toBe('100.00');
    expect((await outboxFor(row.id)).map((event) => event.event_type)).toEqual(['WagerTransactionRejected']);
  });

  it('REFUND before its BET → PENDING_REFERENCE and acked (the reprocessor resolves it later)', async () => {
    const refund = operation(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-not-yet' });
    await sendEnvelope(queues.queue, envelopeFor(refund));
    await waitForStatus(refund, ['PENDING_REFERENCE']);
    await waitForEmptyQueue();
    expect(await queueDepth(queues.dlq)).toBe(0);
  });
});

describe('SQS consumer — permanent failures go straight to the DLQ', () => {
  it('invalid JSON, unknown type, invalid data, OPENING and unknown wallet → DLQ with reason, nothing persisted', async () => {
    const before = await metricValue(consumer.baseUrl, 'sqs_dlq_messages_total');
    const valid = envelopeFor(operation(wallet));
    const cases: { body: string; reason: string; originalMessageId?: string }[] = [
      { body: '{not json', reason: 'INVALID_ENVELOPE' },
      { body: JSON.stringify({ type: 'WagerTransactionRequested', data: {} }), reason: 'INVALID_ENVELOPE' },
      {
        body: JSON.stringify({ ...valid, messageId: 'msg-unknown-type', type: 'SomethingElse' }),
        reason: 'UNKNOWN_MESSAGE_TYPE',
        originalMessageId: 'msg-unknown-type',
      },
      {
        body: JSON.stringify(
          wagerEnvelope({
            messageId: 'msg-number-money',
            data: { ...(valid.data as { walletId: string }), money: { amount: 25, currency: 'BRL' } },
          }),
        ),
        reason: 'VALIDATION_ERROR',
        originalMessageId: 'msg-number-money',
      },
      {
        body: JSON.stringify(envelopeFor(operation(wallet, { kind: 'OPENING' }), { messageId: 'msg-opening' })),
        reason: 'KIND_NOT_ALLOWED',
        originalMessageId: 'msg-opening',
      },
      {
        body: JSON.stringify(
          envelopeFor(operation({ ...wallet, walletId: crypto.randomUUID() }), { messageId: 'msg-no-wallet' }),
        ),
        reason: 'WALLET_NOT_FOUND',
        originalMessageId: 'msg-no-wallet',
      },
    ];
    for (const [index, testCase] of cases.entries()) {
      await sendRaw(queues.queue, testCase.body, { groupId: `bad-${index}` });
    }

    const dlq = await collectDlq(queues.dlq, cases.length);
    expect(dlq).toHaveLength(cases.length);
    for (const testCase of cases) {
      const entry = dlq.find((candidate) => candidate.body === testCase.body);
      expect(entry, testCase.reason).toBeDefined();
      expect(entry?.failureReason).toBe(testCase.reason);
      if (testCase.originalMessageId !== undefined) {
        expect(entry?.originalMessageId).toBe(testCase.originalMessageId);
      }
    }
    await waitForEmptyQueue();
    expect(await transactionsOf(wallet.walletId)).toHaveLength(0);
    expect(await inboxRows()).toHaveLength(0);
    expect(await metricValue(consumer.baseUrl, 'sqs_dlq_messages_total')).toBe(before + cases.length);
    expect(await metricValue(consumer.baseUrl, 'sqs_dlq_messages_total', { reason: 'WALLET_NOT_FOUND' })).toBe(1);
  });

  it('idempotency conflict and a reused messageId with another payload → DLQ; the first effect stays', async () => {
    const bet = operation(wallet);
    await sendEnvelope(queues.queue, envelopeFor(bet, { messageId: 'msg-original' }));
    await waitForStatus(bet, ['PROCESSED']);

    const conflicting = { ...bet, money: { amount: '30.00', currency: 'BRL' } };
    await sendEnvelope(queues.queue, envelopeFor(conflicting, { messageId: 'msg-other-payload' }));
    await sendEnvelope(queues.queue, envelopeFor(conflicting, { messageId: 'msg-original' }));

    const dlq = await collectDlq(queues.dlq, 2);
    expect(dlq.map((entry) => entry.failureReason).sort()).toEqual(['IDEMPOTENCY_CONFLICT', 'INBOX_CONFLICT']);
    expect(dlq.every((entry) => entry.groupId === wallet.walletId)).toBe(true);
    await waitForEmptyQueue();
    expect(await transactionsOf(wallet.walletId)).toHaveLength(1);
    expect(await walletBalance(wallet.walletId)).toBe('75.00');
    expect(await inboxRows()).toHaveLength(1);
    await assertLedgerInvariant([wallet.walletId], { baseUrl: api.baseUrl });
  });
});
