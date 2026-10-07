import { HttpException } from '@nestjs/common';

/** Problema num campo da requisição (`path` no formato `initialBalance.amount`). */
export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

/** Corpo uniforme de erro da API (ESPECIFICACAO.md §6). `details` só aparece em `VALIDATION_ERROR`. */
export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly correlationId: string;
    readonly details?: readonly FieldIssue[];
  };
}

/**
 * Erro da borda HTTP com status e código próprios (ex.: validação de payload, cursor inválido).
 * Erros de domínio não precisam virar `ApiError`: o filtro global os mapeia pelo `FailureCode`.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: readonly FieldIssue[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 400 `VALIDATION_ERROR` com a lista de campos inválidos. */
export class RequestValidationError extends ApiError {
  constructor(details: readonly FieldIssue[]) {
    super(400, 'VALIDATION_ERROR', 'Request validation failed', details);
    this.name = 'RequestValidationError';
  }
}

/**
 * Resposta HTTP cujo corpo **não** é envelopado no formato de erro uniforme. Uso restrito a endpoints
 * operacionais cujo corpo é o contrato (o `/health/ready` devolve 503 com o relatório dos checks, que
 * orquestradores e pessoas leem). Endpoints de negócio nunca usam.
 */
export class PassthroughHttpException extends HttpException {
  constructor(body: Record<string, unknown> | object, status: number) {
    super(body, status);
    this.name = 'PassthroughHttpException';
  }
}
