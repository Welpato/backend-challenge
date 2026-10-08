import { describe, expect, it } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import { InboxPayloadConflictError } from '@/messaging/inbox/inbox.errors';
import { classify, UNEXPECTED_ERROR_REASON } from '@/messaging/sqs/error-classifier';
import { InvalidEnvelopeError, parseWagerEnvelope } from '@/messaging/sqs/message-envelope';
import { groupIdOf, receiveCountOf, retryVisibilitySeconds } from '@/messaging/sqs/wager-queue';
import { FailureCode } from '@/shared/failure-code';
import { TransientDatabaseError } from '@/shared/persistence/pg-errors';
import { IdempotencyConflictError } from '@/wagering/domain/wagering.errors';
import { WalletNotFoundError } from '@/wallet/domain/wallet.errors';

const DATA = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

/** Exemplo exato do enunciado (DESAFIO.md §10). */
const EXAMPLE = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: DATA,
};

function reasonOf(body: unknown): string {
  try {
    parseWagerEnvelope(typeof body === 'string' ? body : JSON.stringify(body));
  } catch (error: unknown) {
    if (error instanceof InvalidEnvelopeError) {
      return error.reason;
    }
    throw error;
  }
  return 'OK';
}

describe('parseWagerEnvelope', () => {
  it('parses the example of the challenge into a command with Money and the idempotency key', () => {
    const envelope = parseWagerEnvelope(JSON.stringify(EXAMPLE));
    expect(envelope.messageId).toBe('msg-123');
    expect(envelope.command.idempotencyKey).toBe('provider-a:transaction-123');
    expect(envelope.command.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(envelope.command).not.toHaveProperty('referenceExternalTransactionId');
    expect(envelope.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the content: same body → same hash; any change in data → other hash; messageId is not part of it', () => {
    const hash = parseWagerEnvelope(JSON.stringify(EXAMPLE)).payloadHash;
    expect(parseWagerEnvelope(JSON.stringify({ ...EXAMPLE, messageId: 'other' })).payloadHash).toBe(hash);
    const changed = { ...EXAMPLE, data: { ...DATA, money: { amount: '25.01', currency: 'BRL' } } };
    expect(parseWagerEnvelope(JSON.stringify(changed)).payloadHash).not.toBe(hash);
  });

  it.each([
    ['not JSON', '{oops', 'INVALID_ENVELOPE'],
    ['empty body', '', 'INVALID_ENVELOPE'],
    ['array', [], 'INVALID_ENVELOPE'],
    ['missing messageId', { ...EXAMPLE, messageId: undefined }, 'INVALID_ENVELOPE'],
    ['messageId with spaces', { ...EXAMPLE, messageId: 'msg 1' }, 'INVALID_ENVELOPE'],
    ['occurredAt not ISO', { ...EXAMPLE, occurredAt: 'yesterday' }, 'INVALID_ENVELOPE'],
    ['unknown type', { ...EXAMPLE, type: 'WalletCreated' }, 'UNKNOWN_MESSAGE_TYPE'],
    ['money as number', { ...EXAMPLE, data: { ...DATA, money: { amount: 25, currency: 'BRL' } } }, 'VALIDATION_ERROR'],
    ['amount "25"', { ...EXAMPLE, data: { ...DATA, money: { amount: '25', currency: 'BRL' } } }, 'VALIDATION_ERROR'],
    ['missing idempotencyKey', { ...EXAMPLE, data: { ...DATA, idempotencyKey: undefined } }, 'VALIDATION_ERROR'],
    ['unknown kind', { ...EXAMPLE, data: { ...DATA, kind: 'JACKPOT' } }, 'VALIDATION_ERROR'],
    ['walletId not UUID', { ...EXAMPLE, data: { ...DATA, walletId: 'w1' } }, 'VALIDATION_ERROR'],
    ['extra field in data', { ...EXAMPLE, data: { ...DATA, extra: 1 } }, 'VALIDATION_ERROR'],
    ['extra field in envelope', { ...EXAMPLE, extra: 1 }, 'VALIDATION_ERROR'],
  ])('rejects %s', (_name, body, reason) => {
    expect(reasonOf(body)).toBe(reason);
  });

  it('never echoes the received amount in the error message', () => {
    try {
      parseWagerEnvelope(
        JSON.stringify({ ...EXAMPLE, data: { ...DATA, money: { amount: '12.345', currency: 'BRL' } } }),
      );
      throw new Error('should have thrown');
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain('12.345');
    }
  });
});

describe('classify', () => {
  it.each([
    [new InvalidEnvelopeError('INVALID_ENVELOPE', 'x'), 'permanent', 'INVALID_ENVELOPE'],
    [new InvalidEnvelopeError('UNKNOWN_MESSAGE_TYPE', 'x'), 'permanent', 'UNKNOWN_MESSAGE_TYPE'],
    [new InboxPayloadConflictError('c', 'm'), 'permanent', 'INBOX_CONFLICT'],
    [new IdempotencyConflictError(FailureCode.IDEMPOTENCY_CONFLICT), 'permanent', 'IDEMPOTENCY_CONFLICT'],
    [new IdempotencyConflictError(FailureCode.EXTERNAL_ID_CONFLICT), 'permanent', 'EXTERNAL_ID_CONFLICT'],
    [new WalletNotFoundError('w'), 'permanent', 'WALLET_NOT_FOUND'],
    [new TransientDatabaseError('deadlock', { cause: undefined }), 'transient', 'TRANSIENT_UNAVAILABLE'],
    [new TransientDatabaseError('connection', { cause: undefined }), 'transient', 'TRANSIENT_UNAVAILABLE'],
    [
      Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
      'transient',
      'TRANSIENT_UNAVAILABLE',
    ],
    [Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'transient', 'TRANSIENT_UNAVAILABLE'],
    [Object.assign(new Error('throttled'), { name: 'ThrottlingException' }), 'transient', 'TRANSIENT_UNAVAILABLE'],
    [new Error('bug'), 'transient', UNEXPECTED_ERROR_REASON],
    ['not even an error', 'transient', UNEXPECTED_ERROR_REASON],
  ])('%p → %s (%s)', (error, errorClass, reason) => {
    expect(classify(error)).toEqual({ class: errorClass as 'permanent' | 'transient', reason });
  });
});

describe('consumer queue helpers', () => {
  it('retry visibility grows with the receive count, never 0, capped by the max', () => {
    const noJitter = () => 0;
    const backoff = { baseMs: 1000, maxMs: 300_000 };
    expect([1, 2, 3, 4, 5].map((count) => retryVisibilitySeconds(count, backoff, noJitter))).toEqual([1, 2, 4, 8, 16]);
    expect(retryVisibilitySeconds(30, backoff, noJitter)).toBe(300);
    expect(retryVisibilitySeconds(1, { baseMs: 1, maxMs: 1000 }, () => 0)).toBe(1);
    expect(retryVisibilitySeconds(1, { baseMs: 13 * 3_600_000, maxMs: 24 * 3_600_000 }, noJitter)).toBe(43_200);
  });

  it('reads the receive count and the group id from the system attributes', () => {
    const message: Message = { MessageId: 'm1', Attributes: { ApproximateReceiveCount: '3', MessageGroupId: 'w1' } };
    expect(receiveCountOf(message)).toBe(3);
    expect(groupIdOf(message)).toBe('w1');
    expect(receiveCountOf({ MessageId: 'm2' })).toBe(1);
    expect(groupIdOf({ MessageId: 'm2' })).toBe('m2');
  });
});
