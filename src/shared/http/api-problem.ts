import { HttpException } from '@nestjs/common';
import { DomainError } from '@/shared/errors/domain-error';
import { FailureCode, failureCodeMetadata, isFailureCode } from '@/shared/failure-code';
import { classifyPgError, TransientDatabaseError } from '@/shared/persistence/pg-errors';
import { ApiError, type FieldIssue } from './api-error';
import { httpStatusForFailureCode, TRANSIENT_RETRY_AFTER_SECONDS } from './failure-http-status';

/** Resultado do mapeamento de uma exceção para a resposta HTTP (sem o `correlationId`, que vem da requisição). */
export interface ApiProblem {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: readonly FieldIssue[];
  readonly retryAfterSeconds?: number;
  /** `true` = erro inesperado (bug/infra): vai para o log com stack em nível `error`. */
  readonly unexpected: boolean;
}

export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';

const INTERNAL: ApiProblem = Object.freeze({
  status: 500,
  code: INTERNAL_ERROR_CODE,
  message: 'Internal server error',
  retryable: false,
  unexpected: true,
});

const TRANSIENT: ApiProblem = Object.freeze({
  status: 503,
  code: FailureCode.TRANSIENT_UNAVAILABLE,
  message: 'Service temporarily unavailable; retry the same request',
  retryable: true,
  retryAfterSeconds: TRANSIENT_RETRY_AFTER_SECONDS,
  unexpected: false,
});

/**
 * Exceções do próprio Nest/Express (rota inexistente, JSON malformado, corpo grande demais…).
 * A mensagem é genérica: a original pode ecoar trechos do payload.
 */
function fromHttpException(exception: HttpException): ApiProblem {
  const status = exception.getStatus();
  if (status === 503) {
    return TRANSIENT;
  }
  if (status >= 500) {
    return INTERNAL;
  }
  const known: Record<number, { code: string; message: string }> = {
    400: { code: FailureCode.VALIDATION_ERROR, message: 'Malformed request' },
    404: { code: 'NOT_FOUND', message: 'Resource not found' },
    405: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
    413: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' },
    415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type' },
  };
  const { code, message } = known[status] ?? { code: 'HTTP_ERROR', message: 'Request failed' };
  return { status, code, message, retryable: false, unexpected: false };
}

function fromDomainError(error: DomainError): ApiProblem {
  if (!isFailureCode(error.code)) {
    // Códigos fora do catálogo (`INVALID_WALLET_OPERATION`, `INVALID_TRANSACTION_STATE`…) são erros de programação.
    return INTERNAL;
  }
  if (error.code === FailureCode.TRANSIENT_UNAVAILABLE) {
    return TRANSIENT;
  }
  const status = httpStatusForFailureCode(error.code);
  if (status >= 500) {
    return INTERNAL;
  }
  return {
    status,
    code: error.code,
    message: error.message,
    retryable: failureCodeMetadata(error.code).retryable,
    unexpected: false,
  };
}

/**
 * Mapeia qualquer exceção para o problema HTTP correspondente (ESPECIFICACAO.md §6):
 * `ApiError` → o próprio status · `DomainError` → status pelo `FailureCode` · falha transitória do banco
 * (lock timeout, deadlock, serialização, conexão) → 503 + `Retry-After` · exceções do Nest → status delas
 * com código padronizado · resto → 500 `INTERNAL_ERROR` (sem detalhes na resposta).
 */
export function toApiProblem(exception: unknown): ApiProblem {
  if (exception instanceof ApiError) {
    return {
      status: exception.status,
      code: exception.code,
      message: exception.message,
      retryable: exception.status === 503,
      ...(exception.details === undefined ? {} : { details: exception.details }),
      ...(exception.status === 503 ? { retryAfterSeconds: TRANSIENT_RETRY_AFTER_SECONDS } : {}),
      unexpected: exception.status >= 500 && exception.status !== 503,
    };
  }
  if (exception instanceof DomainError) {
    return fromDomainError(exception);
  }
  if (exception instanceof HttpException) {
    return fromHttpException(exception);
  }
  if (classifyPgError(exception) instanceof TransientDatabaseError) {
    return TRANSIENT;
  }
  return INTERNAL;
}
