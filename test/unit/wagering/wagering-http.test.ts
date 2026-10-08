import { describe, expect, it } from 'bun:test';
import { ApiError } from '@/shared/http/api-error';
import { Money } from '@/shared/money/money';
import type { ProcessResult } from '@/wagering/application/process-wager-transaction';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';
import { parseIdempotencyKey, submitTransactionBodySchema } from '@/wagering/http/wagering.dto';
import { httpStatusForResult } from '@/wagering/http/wagering.response';

function apiErrorOf(operation: () => unknown): ApiError {
  try {
    operation();
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected an ApiError');
}

describe('parseIdempotencyKey', () => {
  it('returns the header as is', () => {
    expect(parseIdempotencyKey('provider-a:transaction-123')).toBe('provider-a:transaction-123');
    expect(parseIdempotencyKey('k'.repeat(200))).toHaveLength(200);
  });

  it.each([undefined, ''])('treats %p as missing (MISSING_IDEMPOTENCY_KEY)', (header) => {
    expect(apiErrorOf(() => parseIdempotencyKey(header))).toMatchObject({
      status: 400,
      code: 'MISSING_IDEMPOTENCY_KEY',
    });
  });

  it.each([['k'.repeat(201)], [' padded'], [['a', 'b']]])('rejects %p with VALIDATION_ERROR', (header) => {
    expect(apiErrorOf(() => parseIdempotencyKey(header))).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });
});

describe('submitTransactionBodySchema', () => {
  const valid = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  it('accepts the example of the challenge and turns money into Money', () => {
    const parsed = submitTransactionBodySchema.parse(valid);
    expect(parsed.money).toBeInstanceOf(Money);
    expect(parsed.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('accepts OPENING at the edge (the domain refuses it with KIND_NOT_ALLOWED)', () => {
    expect(submitTransactionBodySchema.safeParse({ ...valid, kind: 'OPENING' }).success).toBe(true);
  });

  it.each([
    { money: { amount: 25, currency: 'BRL' } },
    { money: { amount: '25.0', currency: 'BRL' } },
    { kind: 'bet' },
    { walletId: 'nope' },
    { roundId: ' round' },
    { extra: 1 },
  ])('rejects %p', (overrides) => {
    expect(submitTransactionBodySchema.safeParse({ ...valid, ...overrides }).success).toBe(false);
  });
});

describe('httpStatusForResult', () => {
  const tx = {} as WagerTransaction;
  const result = (outcome: ProcessResult['outcome'], idempotentReplay: boolean): ProcessResult => ({
    transaction: tx,
    balance: undefined,
    idempotentReplay,
    inboxDuplicate: false,
    outcome,
  });

  it('maps outcomes to the status of ESPECIFICACAO.md §6', () => {
    expect(httpStatusForResult(result(WagerTransactionStatus.Processed, false))).toBe(201);
    expect(httpStatusForResult(result(WagerTransactionStatus.Processed, true))).toBe(200);
    expect(httpStatusForResult(result(WagerTransactionStatus.PendingReference, false))).toBe(202);
    expect(httpStatusForResult(result(WagerTransactionStatus.PendingReference, true))).toBe(202);
    expect(httpStatusForResult(result(WagerTransactionStatus.Rejected, false))).toBe(422);
    expect(httpStatusForResult(result(WagerTransactionStatus.Rejected, true))).toBe(422);
    expect(httpStatusForResult(result(WagerTransactionStatus.Failed, true))).toBe(500);
  });
});
