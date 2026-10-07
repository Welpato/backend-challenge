import { describe, expect, it } from 'bun:test';
import {
  FAILURE_CODES,
  type FailureClass,
  FailureCode,
  failureCodeMetadata,
  isFailureCode,
} from '@/shared/failure-code';

describe('FailureCode', () => {
  it('lists every code from the specification taxonomy', () => {
    expect<string[]>([...FAILURE_CODES].sort()).toEqual(
      [
        'ALREADY_REVERSED',
        'CURRENCY_MISMATCH',
        'EXTERNAL_ID_CONFLICT',
        'IDEMPOTENCY_CONFLICT',
        'INSUFFICIENT_FUNDS',
        'KIND_NOT_ALLOWED',
        'MISSING_IDEMPOTENCY_KEY',
        'PROCESSING_FAILED',
        'REFERENCE_AMOUNT_MISMATCH',
        'REFERENCE_KIND_NOT_ALLOWED',
        'REFERENCE_MISMATCH',
        'REFERENCE_NOT_FOUND',
        'REFERENCE_NOT_PROCESSED',
        'REVERSAL_INSUFFICIENT_FUNDS',
        'TRANSIENT_UNAVAILABLE',
        'VALIDATION_ERROR',
        'WALLET_NOT_FOUND',
        'WALLET_PLAYER_MISMATCH',
      ].sort(),
    );
  });

  it('maps each code value to its own key', () => {
    for (const [key, value] of Object.entries(FailureCode)) {
      expect(value).toBe(key as FailureCode);
    }
  });

  it('persists business failures as REJECTED and never retries them', () => {
    const business = FAILURE_CODES.filter((code) => failureCodeMetadata(code).class === 'business');
    expect(business).toHaveLength(10);
    for (const code of business) {
      expect(failureCodeMetadata(code)).toEqual({ class: 'business', retryable: false, persisted: 'REJECTED' });
    }
  });

  it('does not persist contract, conflict and not-found failures', () => {
    const expectations: ReadonlyArray<[FailureCode, FailureClass]> = [
      [FailureCode.VALIDATION_ERROR, 'contract'],
      [FailureCode.MISSING_IDEMPOTENCY_KEY, 'contract'],
      [FailureCode.KIND_NOT_ALLOWED, 'contract'],
      [FailureCode.IDEMPOTENCY_CONFLICT, 'conflict'],
      [FailureCode.EXTERNAL_ID_CONFLICT, 'conflict'],
      [FailureCode.WALLET_NOT_FOUND, 'not_found'],
    ];
    for (const [code, failureClass] of expectations) {
      expect(failureCodeMetadata(code)).toEqual({ class: failureClass, retryable: false, persisted: null });
    }
  });

  it('marks only TRANSIENT_UNAVAILABLE as retryable', () => {
    expect(FAILURE_CODES.filter((code) => failureCodeMetadata(code).retryable)).toEqual([
      FailureCode.TRANSIENT_UNAVAILABLE,
    ]);
    expect(failureCodeMetadata(FailureCode.TRANSIENT_UNAVAILABLE)).toEqual({
      class: 'transient',
      retryable: true,
      persisted: null,
    });
  });

  it('persists PROCESSING_FAILED as FAILED', () => {
    expect(failureCodeMetadata(FailureCode.PROCESSING_FAILED)).toEqual({
      class: 'infrastructure',
      retryable: false,
      persisted: 'FAILED',
    });
  });

  it('recognizes failure codes', () => {
    expect(isFailureCode('INSUFFICIENT_FUNDS')).toBe(true);
    expect(isFailureCode('insufficient_funds')).toBe(false);
    expect(isFailureCode('toString')).toBe(false);
    expect(isFailureCode(42)).toBe(false);
  });

  it('metadata cannot be mutated', () => {
    const metadata = failureCodeMetadata(FailureCode.INSUFFICIENT_FUNDS);
    expect(() => {
      (metadata as { retryable: boolean }).retryable = true;
    }).toThrow(TypeError);
  });
});
