import { describe, expect, it } from 'bun:test';
import { InvalidOutboxOperationError } from '@/messaging/outbox/outbox.errors';
import { OUTBOX_LAST_ERROR_MAX_LENGTH, OutboxMessage } from '@/messaging/outbox/outbox-message';
import { Money } from '@/shared/money/money';
import { WalletBalanceChanged } from '@/wallet/domain/events/wallet-balance-changed';
import { Wallet } from '@/wallet/domain/wallet';
import { seededRandom } from '../../support/seeded-random';
import { eventContext, expectFrozenDeep } from '../events/event-fixtures';

const NOW = new Date('2026-10-07T12:00:01.000Z');
const NO_JITTER = { jitterRatio: 0 } as const;
const FIVE_MINUTES = 300_000;

function balanceChanged(): WalletBalanceChanged {
  const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('100.00'),
    openingTransactionId: 'tx-open',
    at: NOW,
  });
  const entry = wallet.debit('tx-bet', brl('25.00'), NOW);
  return WalletBalanceChanged.from(wallet, entry, eventContext());
}

const plus = (date: Date, ms: number) => new Date(date.getTime() + ms);

describe('OutboxMessage.enqueue', () => {
  it('copies identity and envelope from the event and is due immediately', () => {
    const event = balanceChanged();
    const message = OutboxMessage.enqueue(event, NOW);
    expect(message.id).toBe(event.eventId);
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.eventVersion).toBe(1);
    expect(message.correlationId).toBe('corr-1');
    expect(message.occurredAt.toISOString()).toBe(event.occurredAt.toISOString());
    expect(message.payload).toStrictEqual(event.toJSON() as unknown as Record<string, unknown>);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt.toISOString()).toBe(NOW.toISOString());
    expect(message.publishedAt).toBeUndefined();
    expect(message.lastError).toBeUndefined();
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
  });

  it('freezes the payload in depth', () => {
    const message = OutboxMessage.enqueue(balanceChanged(), NOW);
    expectFrozenDeep(message.payload);
    expect(() => {
      (message.payload as Record<string, unknown>).eventType = 'Other';
    }).toThrow(TypeError);
    const data = message.payload.data as { money: { amount: string } };
    expect(() => {
      data.money.amount = '0.01';
    }).toThrow(TypeError);
  });

  it('keeps money as strings in the payload', () => {
    const data = OutboxMessage.enqueue(balanceChanged(), NOW).payload.data as Record<string, unknown>;
    expect(data.money).toStrictEqual({ amount: '25.00', currency: 'BRL' });
    expect(data.balanceAfter).toStrictEqual({ amount: '75.00', currency: 'BRL' });
  });

  it('rejects an invalid now', () => {
    expect(() => OutboxMessage.enqueue(balanceChanged(), new Date('x'))).toThrow(InvalidOutboxOperationError);
  });
});

describe('OutboxMessage.isDue', () => {
  it('is due at and after nextAttemptAt, not before', () => {
    const message = OutboxMessage.enqueue(balanceChanged(), NOW);
    expect(message.isDue(plus(NOW, -1))).toBe(false);
    expect(message.isDue(NOW)).toBe(true);
    expect(message.isDue(plus(NOW, 1))).toBe(true);
  });

  it('is never due once published', () => {
    const message = OutboxMessage.enqueue(balanceChanged(), NOW);
    message.markPublished(NOW);
    expect(message.isDue(plus(NOW, 3_600_000))).toBe(false);
  });
});

describe('OutboxMessage.markPublished', () => {
  it('stops being pending and records the instant', () => {
    const message = OutboxMessage.enqueue(balanceChanged(), NOW);
    const at = plus(NOW, 250);
    message.markPublished(at);
    expect(message.isPending()).toBe(false);
    expect(message.publishedAt?.toISOString()).toBe(at.toISOString());
  });

  it('throws when published twice and keeps the first instant', () => {
    const message = OutboxMessage.enqueue(balanceChanged(), NOW);
    message.markPublished(NOW);
    expect(() => message.markPublished(plus(NOW, 1))).toThrow(InvalidOutboxOperationError);
    expect(message.publishedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('rejects an invalid date without changing state', () => {
    const message = OutboxMessage.enqueue(balanceChanged(), NOW);
    expect(() => message.markPublished(new Date('x'))).toThrow(InvalidOutboxOperationError);
    expect(message.isPending()).toBe(true);
  });

  it('can be published after failed attempts', () => {
    const message = OutboxMessage.enqueue(balanceChanged(), NOW);
    message.scheduleRetry(NOW, 'boom', NO_JITTER);
    message.markPublished(plus(NOW, 5_000));
    expect(message.isPending()).toBe(false);
    expect(message.attempts).toBe(1);
  });
});

describe('OutboxMessage.scheduleRetry', () => {
  it('increments attempts and schedules min(2^attempts × 1s, 5 min)', () => {
    const message = OutboxMessage.enqueue(balanceChanged(), NOW);
    const delays: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      message.scheduleRetry(NOW, `failure ${i}`, NO_JITTER);
      delays.push(message.nextAttemptAt.getTime() - NOW.getTime());
    }
    expect(message.attempts).toBe(12);
    expect(delays).toEqual([
      2_000,
      4_000,
      8_000,
      16_000,
      32_000,
      64_000,
      128_000,
      256_000,
      FIVE_MINUTES,
      FIVE_MINUTES,
      FIVE_MINUTES,
      FIVE_MINUTES,
    ]);
    expect(message.lastError).toBe('failure 11');
    expect(message.isPending()).toBe(true);
  });

  it('respects the cap after many attempts (never gives up)', () => {
    const message = OutboxMessage.rehydrate({
      id: 'evt-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      eventVersion: 1,
      payload: { eventId: 'evt-1' },
      occurredAt: NOW,
      attempts: 5_000,
      nextAttemptAt: NOW,
    });
    message.scheduleRetry(NOW, 'still down', { random: seededRandom(7) });
    expect(message.attempts).toBe(5_001);
    const delay = message.nextAttemptAt.getTime() - NOW.getTime();
    expect(delay).toBeLessThanOrEqual(FIVE_MINUTES);
    expect(delay).toBeGreaterThanOrEqual(FIVE_MINUTES * 0.8);
  });

  it('is not due until the scheduled instant', () => {
    const message = OutboxMessage.enqueue(balanceChanged(), NOW);
    message.scheduleRetry(NOW, 'boom', NO_JITTER);
    expect(message.isDue(plus(NOW, 1_999))).toBe(false);
    expect(message.isDue(plus(NOW, 2_000))).toBe(true);
  });

  it('produces the same schedule for the same jitter seed', () => {
    const schedule = (seed: number) => {
      const random = seededRandom(seed);
      const message = OutboxMessage.enqueue(balanceChanged(), NOW);
      return Array.from({ length: 10 }, () => {
        message.scheduleRetry(NOW, 'boom', { random });
        return message.nextAttemptAt.getTime() - NOW.getTime();
      });
    };
    const first = schedule(20261007);
    expect(schedule(20261007)).toEqual(first);
    expect(schedule(1)).not.toEqual(first);
    first.forEach((delay, i) => {
      const cap = Math.min(1_000 * 2 ** (i + 1), FIVE_MINUTES);
      expect(delay).toBeLessThanOrEqual(cap);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(cap * 0.8));
    });
  });

  it('truncates long error messages', () => {
    const message = OutboxMessage.enqueue(balanceChanged(), NOW);
    message.scheduleRetry(NOW, 'x'.repeat(5_000), NO_JITTER);
    expect(message.lastError).toHaveLength(OUTBOX_LAST_ERROR_MAX_LENGTH);
  });

  it('throws on a published message without changing it', () => {
    const message = OutboxMessage.enqueue(balanceChanged(), NOW);
    message.markPublished(NOW);
    expect(() => message.scheduleRetry(NOW, 'late failure', NO_JITTER)).toThrow(InvalidOutboxOperationError);
    expect(message.attempts).toBe(0);
    expect(message.lastError).toBeUndefined();
  });

  it('rejects an invalid now without changing state', () => {
    const message = OutboxMessage.enqueue(balanceChanged(), NOW);
    expect(() => message.scheduleRetry(new Date('x'), 'boom')).toThrow(InvalidOutboxOperationError);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt.toISOString()).toBe(NOW.toISOString());
  });

  it('rejects a bad random source without changing state', () => {
    const message = OutboxMessage.enqueue(balanceChanged(), NOW);
    expect(() => message.scheduleRetry(NOW, 'boom', { random: () => 2 })).toThrow(RangeError);
    expect(message.attempts).toBe(0);
  });
});

describe('OutboxMessage.rehydrate', () => {
  it('restores a published message with its history', () => {
    const published = new Date('2026-10-07T12:05:00.000Z');
    const message = OutboxMessage.rehydrate({
      id: 'evt-9',
      aggregateId: 'wallet-1',
      eventType: 'WagerTransactionProcessed',
      eventVersion: 1,
      payload: { eventId: 'evt-9', data: { money: { amount: '1.00', currency: 'BRL' } } },
      correlationId: 'corr-9',
      occurredAt: NOW,
      attempts: 3,
      nextAttemptAt: NOW,
      publishedAt: published,
      lastError: 'timeout',
    });
    expect(message.isPending()).toBe(false);
    expect(message.isDue(published)).toBe(false);
    expect(message.attempts).toBe(3);
    expect(message.lastError).toBe('timeout');
    expect(message.publishedAt?.toISOString()).toBe(published.toISOString());
    expectFrozenDeep(message.payload);
  });

  it('copies dates so callers cannot mutate the message', () => {
    const next = new Date(NOW.getTime());
    const message = OutboxMessage.rehydrate({
      id: 'evt-1',
      aggregateId: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      eventVersion: 1,
      payload: {},
      occurredAt: NOW,
      attempts: 0,
      nextAttemptAt: next,
    });
    next.setUTCFullYear(2000);
    message.nextAttemptAt.setUTCFullYear(2001);
    message.occurredAt.setUTCFullYear(2002);
    expect(message.nextAttemptAt.toISOString()).toBe(NOW.toISOString());
    expect(message.occurredAt.toISOString()).toBe(NOW.toISOString());
  });
});
