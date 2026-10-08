import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUuidV7 } from '@/shared/ids';

export const CORRELATION_HEADER = 'x-correlation-id';

/** Aceita ids de clientes só se forem curtos e com charset seguro para logs/headers. */
const ACCEPTED_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Identificadores que acompanham todo log de um fluxo (requisição HTTP, mensagem SQS, pendência do
 * reprocessador) — ESPECIFICACAO.md §10. Só ids e classificadores: nunca valores, saldos ou payloads.
 */
export interface LogContextFields {
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly transactionId?: string | undefined;
  readonly walletId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly kind?: string | undefined;
  readonly status?: string | undefined;
  readonly failureCode?: string | undefined;
}

export interface CorrelationContext extends LogContextFields {
  readonly correlationId: string;
}

type MutableContext = { -readonly [K in keyof LogContextFields]: LogContextFields[K] } & { correlationId: string };

const storage = new AsyncLocalStorage<MutableContext>();

/**
 * Executa `fn` com o contexto de log disponível para todo o fluxo assíncrono (cópia própria: fluxos
 * concorrentes nunca compartilham o objeto).
 */
export function runWithCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Acrescenta identificadores ao contexto corrente (ex.: o use case descobre `transactionId`/`walletId` no meio
 * do fluxo). Campos `undefined` são ignorados. Fora de um contexto não faz nada.
 */
export function addLogContext(fields: LogContextFields): void {
  const store = storage.getStore();
  if (store === undefined) {
    return;
  }
  for (const [key, value] of Object.entries(fields) as [keyof LogContextFields, string | undefined][]) {
    if (value !== undefined) {
      store[key] = value;
    }
  }
}

/** Contexto corrente para o `mixin` do pino (só campos definidos). */
export function currentLogContext(): LogContextFields {
  const store = storage.getStore();
  if (store === undefined) {
    return {};
  }
  return Object.fromEntries(Object.entries(store).filter(([, value]) => value !== undefined));
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
