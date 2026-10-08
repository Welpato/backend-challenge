import { describe, expect, it } from 'bun:test';
import { PendingReferencePolicy } from '@/wagering/application/pending-reference-policy';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const policy = new PendingReferencePolicy({
  backoffBaseMs: 2000,
  backoffMaxMs: 300_000,
  maxAttempts: 12,
  ttlMs: 1_800_000,
  random: () => 0,
});

describe('PendingReferencePolicy', () => {
  it('backs off 2s·2ⁿ capped at 5 minutes (jitter only shortens the delay)', () => {
    const delays = [0, 1, 2, 3, 8, 20].map((exponent) => policy.nextAttemptAt(NOW, exponent).getTime() - NOW.getTime());
    expect(delays).toEqual([2000, 4000, 8000, 16000, 300_000, 300_000]);
    const jittered = new PendingReferencePolicy({
      backoffBaseMs: 2000,
      backoffMaxMs: 300_000,
      maxAttempts: 1,
      ttlMs: 1000,
      random: () => 0.5,
    });
    expect(jittered.nextAttemptAt(NOW, 0).getTime() - NOW.getTime()).toBe(1800);
  });

  it('is exhausted after maxAttempts reschedules or once the TTL has passed', () => {
    const createdAt = new Date(NOW.getTime() - 60_000);
    expect(policy.isExhausted(createdAt, 11, NOW)).toBe(false);
    expect(policy.isExhausted(createdAt, 12, NOW)).toBe(true);
    expect(policy.isExhausted(new Date(NOW.getTime() - 1_799_999), 0, NOW)).toBe(false);
    expect(policy.isExhausted(new Date(NOW.getTime() - 1_800_000), 0, NOW)).toBe(true);
  });

  it('lands the last of 12 attempts close to the 30 minute TTL', () => {
    let elapsed = 2000;
    for (let attempts = 1; attempts <= 12; attempts += 1) {
      elapsed += policy.nextAttemptAt(NOW, attempts).getTime() - NOW.getTime();
    }
    expect(elapsed).toBeGreaterThan(25 * 60_000);
    expect(elapsed).toBeLessThan(45 * 60_000);
  });
});
