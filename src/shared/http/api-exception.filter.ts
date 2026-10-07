import type { IncomingMessage } from 'node:http';
import { type ArgumentsHost, Catch, type ExceptionFilter, Inject, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { currentCorrelationId } from '@/shared/observability/correlation';
import { classifyPgError, TransientDatabaseError } from '@/shared/persistence/pg-errors';
import { type ErrorBody, PassthroughHttpException } from './api-error';
import { toApiProblem } from './api-problem';

type RequestWithCorrelation = IncomingMessage & { correlationId?: string };

/**
 * Filtro global de exceções da API: toda falha sai como `{ error: { code, message, retryable, correlationId } }`
 * com o status de `toApiProblem` (ESPECIFICACAO.md §6). Falhas transitórias levam `Retry-After`.
 * Erros inesperados são logados com stack (a resposta nunca carrega detalhes internos).
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithCorrelation>();
    const response = http.getResponse<unknown>();
    const adapter = this.adapterHost.httpAdapter;

    if (exception instanceof PassthroughHttpException) {
      adapter.reply(response, exception.getResponse(), exception.getStatus());
      return;
    }

    const problem = toApiProblem(exception);
    const correlationId = request.correlationId ?? currentCorrelationId() ?? 'unknown';
    if (problem.unexpected) {
      this.logger.error(
        { err: exception, path: request.url, method: request.method },
        'Unexpected error while handling request',
      );
    } else if (problem.status === 503) {
      const reason = classifyPgError(exception);
      this.logger.warn(
        { reason: reason instanceof TransientDatabaseError ? reason.reason : undefined },
        'Transient failure while handling request',
      );
    }
    if (problem.retryAfterSeconds !== undefined) {
      adapter.setHeader(response, 'Retry-After', String(problem.retryAfterSeconds));
    }
    const body: ErrorBody = {
      error: {
        code: problem.code,
        message: problem.message,
        retryable: problem.retryable,
        correlationId,
        ...(problem.details === undefined ? {} : { details: problem.details }),
      },
    };
    adapter.reply(response, body, problem.status);
  }
}
