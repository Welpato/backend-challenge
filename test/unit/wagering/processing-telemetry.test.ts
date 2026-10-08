import { describe, expect, it } from 'bun:test';
import { Registry } from 'prom-client';
import { AppMetrics } from '@/shared/observability/app-metrics';
import { addLogContext, currentLogContext, runWithCorrelation } from '@/shared/observability/correlation';
import { ConcurrencyInvariantError, WalletVersionConflictError } from '@/shared/persistence/persistence.errors';
import { TransientDatabaseError } from '@/shared/persistence/pg-errors';
import { IdempotencyConflictError } from '@/wagering/domain/wagering.errors';
import {
  failureCodeOf,
  lockConflictTypeOf,
  PrometheusProcessingTelemetry,
} from '@/wagering/infrastructure/prometheus-processing-telemetry';

describe('lockConflictTypeOf', () => {
  it.each([
    [new TransientDatabaseError('lock_timeout', { cause: undefined }), 'timeout'],
    [new TransientDatabaseError('deadlock', { cause: undefined }), 'deadlock'],
    [Object.assign(new Error('deadlock detected'), { code: '40P01' }), 'deadlock'],
    [Object.assign(new Error('wrapper'), { cause: Object.assign(new Error('x'), { code: '55P03' }) }), 'timeout'],
    [new WalletVersionConflictError('stale'), 'version'],
    [new ConcurrencyInvariantError('other invariant'), undefined],
    [new TransientDatabaseError('connection', { cause: undefined }), undefined],
    [new Error('bug'), undefined],
  ])('%p → %p', (error, type) => {
    expect(lockConflictTypeOf(error)).toBe(type as ReturnType<typeof lockConflictTypeOf>);
  });
});

describe('failureCodeOf', () => {
  it('uses the domain code, TRANSIENT_UNAVAILABLE for database outages and INTERNAL_ERROR otherwise', () => {
    expect(failureCodeOf(new IdempotencyConflictError('IDEMPOTENCY_CONFLICT'))).toBe('IDEMPOTENCY_CONFLICT');
    expect(failureCodeOf(new TransientDatabaseError('connection', { cause: undefined }))).toBe('TRANSIENT_UNAVAILABLE');
    expect(failureCodeOf(new Error('amount 25.00 broke'))).toBe('INTERNAL_ERROR');
  });
});

describe('PrometheusProcessingTelemetry', () => {
  it('counts lock conflicts by type and observes the lock wait', async () => {
    const registry = new Registry();
    const telemetry = new PrometheusProcessingTelemetry(new AppMetrics(registry));
    telemetry.attemptFailed(new TransientDatabaseError('deadlock', { cause: undefined }));
    telemetry.attemptFailed(new WalletVersionConflictError('stale'));
    telemetry.attemptFailed(new Error('not a lock problem'));
    telemetry.walletLockAcquired(12);
    const text = await registry.metrics();
    expect(text).toContain('wallet_lock_conflicts_total{type="deadlock"} 1');
    expect(text).toContain('wallet_lock_conflicts_total{type="version"} 1');
    expect(text).not.toContain('wallet_lock_conflicts_total{type="timeout"}');
    expect(text).toContain('wallet_lock_wait_seconds_count 1');
    expect(text).toContain('wallet_lock_wait_seconds_bucket{le="0.025"} 1');
  });
});

describe('log context', () => {
  it('adds identifiers to the current flow only, ignoring undefined values', async () => {
    const inside = await runWithCorrelation({ correlationId: 'c-1' }, async () => {
      addLogContext({ walletId: 'w-1', kind: 'BET', failureCode: undefined });
      await Bun.sleep(1);
      addLogContext({ correlationId: 'c-2', transactionId: 't-1' });
      return currentLogContext();
    });
    expect(inside).toEqual({ correlationId: 'c-2', walletId: 'w-1', kind: 'BET', transactionId: 't-1' });
    expect(currentLogContext()).toEqual({});
    addLogContext({ walletId: 'outside' });
    expect(currentLogContext()).toEqual({});
  });

  it('concurrent flows never share fields', async () => {
    const [a, b] = await Promise.all(
      ['a', 'b'].map((id) =>
        runWithCorrelation({ correlationId: id }, async () => {
          await Bun.sleep(id === 'a' ? 5 : 1);
          addLogContext({ messageId: `msg-${id}` });
          await Bun.sleep(1);
          return currentLogContext();
        }),
      ),
    );
    expect(a).toEqual({ correlationId: 'a', messageId: 'msg-a' });
    expect(b).toEqual({ correlationId: 'b', messageId: 'msg-b' });
  });
});
