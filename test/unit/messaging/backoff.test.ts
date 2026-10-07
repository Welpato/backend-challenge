import { describe, expect, it } from 'bun:test';
import { backoffDelayMs, nextAttemptAt, OUTBOX_BACKOFF } from '@/messaging/outbox/backoff';
import { seededRandom } from '../../support/seeded-random';

const FIVE_MINUTES = 300_000;

describe('backoffDelayMs', () => {
  it('doubles from the base without jitter: min(2^n × 1s, 5 min)', () => {
    const delays = [0, 1, 2, 3, 4, 8, 9, 30].map((n) => backoffDelayMs(n, { ...OUTBOX_BACKOFF, jitterRatio: 0 }));
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 256_000, FIVE_MINUTES, FIVE_MINUTES]);
  });

  it('never exceeds the cap, even for huge exponents (no Infinity/NaN)', () => {
    for (const n of [9, 50, 1_023, 1_024, 10_000]) {
      const delay = backoffDelayMs(n, { ...OUTBOX_BACKOFF, random: () => 0 });
      expect(delay).toBe(FIVE_MINUTES);
    }
  });

  it('jitter only shortens the delay, within [(1 - ratio) × cap, cap]', () => {
    const random = seededRandom(20261007);
    for (let n = 0; n < 200; n += 1) {
      const exponent = n % 12;
      const cap = Math.min(1_000 * 2 ** exponent, FIVE_MINUTES);
      const delay = backoffDelayMs(exponent, { ...OUTBOX_BACKOFF, jitterRatio: 0.2, random });
      expect(delay).toBeLessThanOrEqual(cap);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(cap * 0.8));
      expect(Number.isInteger(delay)).toBe(true);
    }
  });

  it('is deterministic for the same seed', () => {
    const run = (seed: number) => {
      const random = seededRandom(seed);
      return Array.from({ length: 10 }, (_, n) => backoffDelayMs(n, { ...OUTBOX_BACKOFF, random }));
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('maps random() = 0 to the cap and random() → 1 to the lower bound', () => {
    expect(backoffDelayMs(3, { baseMs: 1_000, maxMs: 60_000, jitterRatio: 0.5, random: () => 0 })).toBe(8_000);
    expect(backoffDelayMs(3, { baseMs: 1_000, maxMs: 60_000, jitterRatio: 0.5, random: () => 0.999999 })).toBe(4_000);
  });

  it('supports the reprocessor shape (2s · 2^n)', () => {
    expect(backoffDelayMs(0, { baseMs: 2_000, maxMs: FIVE_MINUTES, jitterRatio: 0 })).toBe(2_000);
    expect(backoffDelayMs(4, { baseMs: 2_000, maxMs: FIVE_MINUTES, jitterRatio: 0 })).toBe(32_000);
  });

  it('does not call random() when jitter is disabled', () => {
    const random = () => {
      throw new Error('should not be called');
    };
    expect(backoffDelayMs(1, { ...OUTBOX_BACKOFF, jitterRatio: 0, random })).toBe(2_000);
  });

  it.each([
    ['negative exponent', -1, {}],
    ['fractional exponent', 1.5, {}],
    ['negative base', 1, { baseMs: -1 }],
    ['infinite cap', 1, { maxMs: Number.POSITIVE_INFINITY }],
    ['jitter ratio above 1', 1, { jitterRatio: 1.5 }],
    ['negative jitter ratio', 1, { jitterRatio: -0.1 }],
    ['random() = 1', 1, { random: () => 1 }],
    ['random() negative', 1, { random: () => -0.1 }],
    ['random() NaN', 1, { random: () => Number.NaN }],
  ])('rejects %s', (_label, exponent, overrides) => {
    expect(() => backoffDelayMs(exponent, { ...OUTBOX_BACKOFF, ...overrides })).toThrow(RangeError);
  });
});

describe('nextAttemptAt', () => {
  it('adds the delay to now without mutating it', () => {
    const now = new Date('2026-10-07T12:00:00.000Z');
    const next = nextAttemptAt(now, 2, { ...OUTBOX_BACKOFF, jitterRatio: 0 });
    expect(next.toISOString()).toBe('2026-10-07T12:00:04.000Z');
    expect(now.toISOString()).toBe('2026-10-07T12:00:00.000Z');
  });
});
