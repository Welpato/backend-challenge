import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUuidV7 } from '@/shared/ids';

export const CORRELATION_HEADER = 'x-correlation-id';

/** Aceita ids de clientes só se forem curtos e com charset seguro para logs/headers. */
const ACCEPTED_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface CorrelationContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/** Executa `fn` com o contexto de correlação disponível para todo o fluxo assíncrono. */
export function runWithCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/** Reaproveita o id recebido quando é válido; caso contrário gera um UUID v7. */
export function resolveCorrelationId(received: string | string[] | undefined): string {
  const candidate = Array.isArray(received) ? received[0] : received;
  return candidate !== undefined && ACCEPTED_CORRELATION_ID.test(candidate) ? candidate : newUuidV7();
}

type RequestWithCorrelation = IncomingMessage & { correlationId?: string };

/**
 * Middleware HTTP (registrado antes de todos os outros): lê `X-Correlation-Id` ou gera um,
 * devolve no header da resposta e abre o contexto `AsyncLocalStorage` para o resto da requisição.
 */
export function correlationMiddleware(req: RequestWithCorrelation, res: ServerResponse, next: () => void): void {
  const correlationId = resolveCorrelationId(req.headers[CORRELATION_HEADER]);
  req.correlationId = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  runWithCorrelation({ correlationId }, next);
}
