import { describe, expect, it } from 'bun:test';
import {
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DomainError } from '@/shared/errors/domain-error';
import { FAILURE_CODES, FailureCode, failureCodeMetadata } from '@/shared/failure-code';
import { ApiError, RequestValidationError } from '@/shared/http/api-error';
import { toApiProblem } from '@/shared/http/api-problem';
import { httpStatusForFailureCode } from '@/shared/http/failure-http-status';
import { InvalidMoneyError } from '@/shared/money/money.errors';
import { ConcurrencyInvariantError } from '@/shared/persistence/persistence.errors';
import { CheckViolationError, TransientDatabaseError, UniqueViolationError } from '@/shared/persistence/pg-errors';
import {
  InvalidWalletOperationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '@/wallet/domain/wallet.errors';

class CodedError extends DomainError {
  constructor(code: string) {
    super(code, `message for ${code}`);
  }
}

describe('httpStatusForFailureCode (ESPECIFICACAO.md §6)', () => {
  it('maps every failure class to its status', () => {
    const expected: Record<string, number> = {
      business: 422,
      contract: 400,
      conflict: 409,
      not_found: 404,
      transient: 503,
      infrastructure: 500,
    };
    for (const code of FAILURE_CODES) {
      expect([code, httpStatusForFailureCode(code)]).toEqual([code, expected[failureCodeMetadata(code).class] ?? -1]);
    }
  });

  it('pins the statuses used by the wallet endpoints', () => {
    expect(httpStatusForFailureCode(FailureCode.VALIDATION_ERROR)).toBe(400);
    expect(httpStatusForFailureCode(FailureCode.WALLET_ALREADY_EXISTS)).toBe(409);
    expect(httpStatusForFailureCode(FailureCode.WALLET_NOT_FOUND)).toBe(404);
    expect(httpStatusForFailureCode(FailureCode.TRANSIENT_UNAVAILABLE)).toBe(503);
  });
});

describe('toApiProblem', () => {
  it('keeps status, code and details of ApiError', () => {
    const problem = toApiProblem(new RequestValidationError([{ path: 'playerId', message: 'must not be empty' }]));
    expect(problem).toEqual({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      retryable: false,
      details: [{ path: 'playerId', message: 'must not be empty' }],
      unexpected: false,
    });
    expect(toApiProblem(new ApiError(503, 'TRANSIENT_UNAVAILABLE', 'down'))).toMatchObject({
      status: 503,
      retryable: true,
      retryAfterSeconds: 1,
    });
  });

  it('maps domain errors by FailureCode', () => {
    expect(toApiProblem(new WalletNotFoundError('w'))).toEqual({
      status: 404,
      code: 'WALLET_NOT_FOUND',
      message: 'Wallet not found',
      retryable: false,
      unexpected: false,
    });
    expect(toApiProblem(new WalletAlreadyExistsError())).toMatchObject({ status: 409, code: 'WALLET_ALREADY_EXISTS' });
    expect(toApiProblem(new InvalidMoneyError('bad'))).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(toApiProblem(new CodedError(FailureCode.INSUFFICIENT_FUNDS))).toMatchObject({
      status: 422,
      code: 'INSUFFICIENT_FUNDS',
      retryable: false,
    });
    expect(toApiProblem(new CodedError(FailureCode.IDEMPOTENCY_CONFLICT))).toMatchObject({ status: 409 });
    expect(toApiProblem(new CodedError(FailureCode.TRANSIENT_UNAVAILABLE))).toMatchObject({
      status: 503,
      retryable: true,
      retryAfterSeconds: 1,
    });
  });

  it('hides programming errors and infrastructure failures behind 500 INTERNAL_ERROR', () => {
    const internal = { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error', retryable: false };
    for (const error of [
      new InvalidWalletOperationError('secret detail'),
      new CodedError(FailureCode.PROCESSING_FAILED),
      new ConcurrencyInvariantError('version mismatch'),
      new UniqueViolationError('uq_x', { cause: undefined }),
      new CheckViolationError('trg_wallet_ledger_consistency', { cause: undefined }),
      new Error('boom'),
      'a string',
      undefined,
      new InternalServerErrorException('detail'),
    ]) {
      expect(toApiProblem(error)).toMatchObject({ ...internal, unexpected: true });
    }
  });

  it('maps transient database failures (direct or wrapped) to 503 + Retry-After', () => {
    const transient = { status: 503, code: 'TRANSIENT_UNAVAILABLE', retryable: true, retryAfterSeconds: 1 };
    for (const reason of ['serialization', 'deadlock', 'lock_timeout', 'connection'] as const) {
      expect(toApiProblem(new TransientDatabaseError(reason, { cause: undefined }))).toMatchObject(transient);
    }
    expect(toApiProblem(Object.assign(new Error('lock'), { code: '55P03' }))).toMatchObject(transient);
    expect(
      toApiProblem(new Error('wrapper', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) })),
    ).toMatchObject(transient);
    expect(toApiProblem(new ServiceUnavailableException())).toMatchObject(transient);
  });

  it('standardizes Nest HTTP exceptions without echoing their message', () => {
    expect(toApiProblem(new NotFoundException('Cannot GET /x'))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Resource not found',
      retryable: false,
      unexpected: false,
    });
    expect(toApiProblem(new BadRequestException('Unexpected token } in JSON: {"amount": 9'))).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Malformed request',
    });
    expect(toApiProblem(new PayloadTooLargeException())).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(toApiProblem(new HttpException('teapot', 418))).toMatchObject({ status: 418, code: 'HTTP_ERROR' });
  });
});
