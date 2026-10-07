import { describe, expect, it } from 'bun:test';
import { FixedClock, SystemClock } from '@/shared/clock';

describe('SystemClock', () => {
  it('returns the current time', () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('FixedClock', () => {
  it('returns the configured instant', () => {
    const clock = new FixedClock('2026-10-07T12:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-10-07T12:00:00.000Z');
  });

  it('returns a copy that callers cannot mutate', () => {
    const clock = new FixedClock('2026-10-07T12:00:00.000Z');
    clock.now().setFullYear(2000);
    expect(clock.now().toISOString()).toBe('2026-10-07T12:00:00.000Z');
  });

  it('does not keep a reference to the given Date', () => {
    const at = new Date('2026-10-07T12:00:00.000Z');
    const clock = new FixedClock(at);
    at.setFullYear(2000);
    expect(clock.now().toISOString()).toBe('2026-10-07T12:00:00.000Z');
  });

  it('can be advanced and set', () => {
    const clock = new FixedClock('2026-10-07T12:00:00.000Z');
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe('2026-10-07T12:00:01.500Z');
    clock.set('2027-01-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('rejects invalid dates', () => {
    expect(() => new FixedClock('not a date')).toThrow(RangeError);
    expect(() => new FixedClock().advance(Number.NaN)).toThrow(RangeError);
  });
});
