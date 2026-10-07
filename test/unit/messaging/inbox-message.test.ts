import { describe, expect, it } from 'bun:test';
import { InvalidInboxOperationError } from '@/messaging/inbox/inbox.errors';
import { InboxMessage, type ReceiveInboxProps } from '@/messaging/inbox/inbox-message';

const RECEIVED = new Date('2026-10-07T12:00:00.000Z');
const PROCESSED = new Date('2026-10-07T12:00:00.050Z');
const HASH = 'ab'.repeat(32);

const props = (overrides: Partial<ReceiveInboxProps> = {}): ReceiveInboxProps => ({
  messageId: 'msg-1',
  consumerName: 'wager-consumer',
  payloadHash: HASH,
  receivedAt: RECEIVED,
  ...overrides,
});

describe('InboxMessage', () => {
  it('receives an unprocessed message', () => {
    const message = InboxMessage.receive(props());
    expect(message.messageId).toBe('msg-1');
    expect(message.consumerName).toBe('wager-consumer');
    expect(message.payloadHash).toBe(HASH);
    expect(message.receivedAt.toISOString()).toBe(RECEIVED.toISOString());
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  it('marks as processed once', () => {
    const message = InboxMessage.receive(props());
    message.markProcessed(PROCESSED);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt?.toISOString()).toBe(PROCESSED.toISOString());
  });

  it('throws when marked as processed twice and keeps the first instant', () => {
    const message = InboxMessage.receive(props());
    message.markProcessed(PROCESSED);
    expect(() => message.markProcessed(new Date('2026-10-07T12:01:00.000Z'))).toThrow(InvalidInboxOperationError);
    expect(message.processedAt?.toISOString()).toBe(PROCESSED.toISOString());
  });

  it('throws on markProcessed of a rehydrated processed message', () => {
    const message = InboxMessage.rehydrate({ ...props(), processedAt: PROCESSED });
    expect(message.isProcessed()).toBe(true);
    expect(() => message.markProcessed(PROCESSED)).toThrow(InvalidInboxOperationError);
  });

  it('rehydrates an unprocessed message without validating', () => {
    const message = InboxMessage.rehydrate({ ...props(), payloadHash: 'legacy' });
    expect(message.isProcessed()).toBe(false);
    expect(message.payloadHash).toBe('legacy');
  });

  it('rejects an invalid processedAt without changing state', () => {
    const message = InboxMessage.receive(props());
    expect(() => message.markProcessed(new Date('x'))).toThrow(InvalidInboxOperationError);
    expect(message.isProcessed()).toBe(false);
  });

  it('copies dates on input and output', () => {
    const received = new Date(RECEIVED.getTime());
    const message = InboxMessage.receive(props({ receivedAt: received }));
    received.setUTCFullYear(2000);
    message.receivedAt.setUTCFullYear(2001);
    message.markProcessed(PROCESSED);
    message.processedAt?.setUTCFullYear(2002);
    expect(message.receivedAt.toISOString()).toBe(RECEIVED.toISOString());
    expect(message.processedAt?.toISOString()).toBe(PROCESSED.toISOString());
  });

  it.each([
    ['empty messageId', { messageId: '' }],
    ['empty consumerName', { consumerName: '' }],
    ['uppercase hash', { payloadHash: 'AB'.repeat(32) }],
    ['short hash', { payloadHash: 'ab' }],
    ['invalid receivedAt', { receivedAt: new Date('x') }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => InboxMessage.receive(props(overrides))).toThrow(InvalidInboxOperationError);
  });

  it('reports INVALID_INBOX_OPERATION as the error code', () => {
    const message = InboxMessage.receive(props());
    message.markProcessed(PROCESSED);
    try {
      message.markProcessed(PROCESSED);
      throw new Error('expected to throw');
    } catch (error) {
      expect((error as InvalidInboxOperationError).code).toBe('INVALID_INBOX_OPERATION');
    }
  });
});
