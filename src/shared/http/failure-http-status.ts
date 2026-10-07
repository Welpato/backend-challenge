import { type FailureClass, type FailureCode, failureCodeMetadata } from '@/shared/failure-code';

/**
 * Status HTTP por classe de falha (ESPECIFICACAO.md §6). Base comum de todos os endpoints:
 * - `contract` (payload inválido, sem `Idempotency-Key`, OPENING submetido) → 400;
 * - `conflict` (idempotência, external id, wallet duplicada) → 409;
 * - `not_found` → 404;
 * - `business` → 422 (no fluxo de transação, a F09 responde 422 com o corpo da transação rejeitada);
 * - `transient` → 503 + `Retry-After`;
 * - `infrastructure` → 500.
 */
const STATUS_BY_CLASS: Readonly<Record<FailureClass, number>> = Object.freeze({
  contract: 400,
  conflict: 409,
  not_found: 404,
  business: 422,
  transient: 503,
  infrastructure: 500,
});

export function httpStatusForFailureCode(code: FailureCode): number {
  return STATUS_BY_CLASS[failureCodeMetadata(code).class];
}

/** Segundos sugeridos no `Retry-After` de falhas transitórias. */
export const TRANSIENT_RETRY_AFTER_SECONDS = 1;
