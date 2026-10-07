import { describe, expect, it } from 'bun:test';
import {
  CheckViolationError,
  classifyPgError,
  isTransientDatabaseError,
  isUniqueViolation,
  TransientDatabaseError,
  UniqueViolationError,
} from '@/shared/persistence/pg-errors';

function pgError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`pg ${code}`), { code, ...extra });
}

describe('classifyPgError', () => {
  it('maps 23505 to UniqueViolationError with the constraint name', () => {
    const classified = classifyPgError(pgError('23505', { constraint: 'uq_wager_transactions_idempotency_key' }));
    expect(classified).toBeInstanceOf(UniqueViolationError);
    expect(classified).toMatchObject({ constraint: 'uq_wager_transactions_idempotency_key' });
    expect(isUniqueViolation(pgError('23505', { constraint: 'ux_reversal_once' }), 'ux_reversal_once')).toBe(true);
    expect(isUniqueViolation(pgError('23505', { constraint: 'ux_reversal_once' }), 'other')).toBe(false);
  });

  it('maps 23514 to CheckViolationError with the constraint name', () => {
    const classified = classifyPgError(pgError('23514', { constraint: 'trg_wallet_ledger_consistency' }));
    expect(classified).toBeInstanceOf(CheckViolationError);
    expect(classified).toMatchObject({ constraint: 'trg_wallet_ledger_consistency' });
  });

  it.each([
    ['40001', 'serialization'],
    ['40P01', 'deadlock'],
    ['55P03', 'lock_timeout'],
    ['57P01', 'connection'],
    ['57P02', 'connection'],
    ['57P03', 'connection'],
    ['08006', 'connection'],
    ['08003', 'connection'],
  ])('maps SQLSTATE %s to a transient %s error', (code, reason) => {
    const classified = classifyPgError(pgError(code));
    expect(classified).toBeInstanceOf(TransientDatabaseError);
    expect(classified).toMatchObject({ reason, sqlState: code });
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'])('maps socket error %s to connection', (code) => {
    expect(classifyPgError(pgError(code))).toMatchObject({ reason: 'connection' });
  });

  it('maps driver messages without code to connection', () => {
    expect(classifyPgError(new Error('Connection terminated unexpectedly'))).toMatchObject({ reason: 'connection' });
    expect(classifyPgError(new Error('timeout exceeded when trying to connect'))).toMatchObject({
      reason: 'connection',
    });
  });

  it('follows the cause chain and keeps the original as cause', () => {
    const original = pgError('55P03');
    const wrapped = new Error('wrapper', { cause: new Error('middle', { cause: original }) });
    const classified = classifyPgError(wrapped);
    expect(classified).toBeInstanceOf(TransientDatabaseError);
    expect(classified?.cause).toBe(original);
    expect(isTransientDatabaseError(wrapped)).toBe(true);
  });

  it('returns already-classified errors unchanged', () => {
    const transient = new TransientDatabaseError('deadlock', { sqlState: '40P01', cause: undefined });
    expect(classifyPgError(transient)).toBe(transient);
  });

  it.each([
    ['42501 insufficient privilege', pgError('42501')],
    ['P0001 raise exception (immutability)', pgError('P0001')],
    ['plain error', new Error('boom')],
    ['string', 'boom'],
    ['null', null],
    ['undefined', undefined],
  ])('leaves %s unclassified', (_label, error) => {
    expect(classifyPgError(error)).toBeUndefined();
    expect(isTransientDatabaseError(error)).toBe(false);
  });
});
