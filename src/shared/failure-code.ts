/**
 * Taxonomia de códigos de falha (ESPECIFICACAO.md §3.8).
 *
 * Cada código carrega metadados usados pelas camadas de borda:
 * - `class`: natureza da falha (negócio, contrato, conflito, não encontrado, transitória, infraestrutura);
 * - `retryable`: se o provedor pode reenviar a **mesma** operação com a mesma `Idempotency-Key`;
 * - `persisted`: status com que a transação é gravada quando a falha acontece (`null` = nada é persistido).
 */
export const FailureCode = {
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  REVERSAL_INSUFFICIENT_FUNDS: 'REVERSAL_INSUFFICIENT_FUNDS',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  WALLET_PLAYER_MISMATCH: 'WALLET_PLAYER_MISMATCH',
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
  REFERENCE_MISMATCH: 'REFERENCE_MISMATCH',
  REFERENCE_AMOUNT_MISMATCH: 'REFERENCE_AMOUNT_MISMATCH',
  REFERENCE_KIND_NOT_ALLOWED: 'REFERENCE_KIND_NOT_ALLOWED',
  REFERENCE_NOT_PROCESSED: 'REFERENCE_NOT_PROCESSED',
  ALREADY_REVERSED: 'ALREADY_REVERSED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MISSING_IDEMPOTENCY_KEY: 'MISSING_IDEMPOTENCY_KEY',
  KIND_NOT_ALLOWED: 'KIND_NOT_ALLOWED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  EXTERNAL_ID_CONFLICT: 'EXTERNAL_ID_CONFLICT',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  WALLET_ALREADY_EXISTS: 'WALLET_ALREADY_EXISTS',
  TRANSIENT_UNAVAILABLE: 'TRANSIENT_UNAVAILABLE',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export type FailureClass = 'business' | 'contract' | 'conflict' | 'not_found' | 'transient' | 'infrastructure';

/** Status terminal com que a transação é persistida; `null` quando a falha não grava a transação. */
export type FailurePersistence = 'REJECTED' | 'FAILED' | null;

export interface FailureCodeMetadata {
  readonly class: FailureClass;
  readonly retryable: boolean;
  readonly persisted: FailurePersistence;
}

function meta(failureClass: FailureClass, retryable: boolean, persisted: FailurePersistence): FailureCodeMetadata {
  return Object.freeze({ class: failureClass, retryable, persisted });
}

const business = meta('business', false, 'REJECTED');
const contract = meta('contract', false, null);
const conflict = meta('conflict', false, null);

const METADATA: Readonly<Record<FailureCode, FailureCodeMetadata>> = Object.freeze({
  INSUFFICIENT_FUNDS: business,
  REVERSAL_INSUFFICIENT_FUNDS: business,
  CURRENCY_MISMATCH: business,
  WALLET_PLAYER_MISMATCH: business,
  // Só é gravado depois que o TTL/limite de tentativas da referência pendente se esgota.
  REFERENCE_NOT_FOUND: business,
  REFERENCE_MISMATCH: business,
  REFERENCE_AMOUNT_MISMATCH: business,
  REFERENCE_KIND_NOT_ALLOWED: business,
  REFERENCE_NOT_PROCESSED: business,
  ALREADY_REVERSED: business,
  VALIDATION_ERROR: contract,
  MISSING_IDEMPOTENCY_KEY: contract,
  KIND_NOT_ALLOWED: contract,
  IDEMPOTENCY_CONFLICT: conflict,
  EXTERNAL_ID_CONFLICT: conflict,
  // Sem wallet não há alvo para a FK de wager_transactions: nada é persistido.
  WALLET_NOT_FOUND: meta('not_found', false, null),
  // `CreateWallet` (§5): `(player_id, currency)` já existe. Não está na tabela §3.8; entrou no catálogo na F08.
  WALLET_ALREADY_EXISTS: conflict,
  // Única falha em que o provedor deve reenviar a mesma operação com a mesma key.
  TRANSIENT_UNAVAILABLE: meta('transient', true, null),
  // Só para transações já persistidas cujas tentativas de infraestrutura se esgotaram.
  PROCESSING_FAILED: meta('infrastructure', false, 'FAILED'),
});

export const FAILURE_CODES: readonly FailureCode[] = Object.freeze(Object.values(FailureCode));

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === 'string' && Object.hasOwn(METADATA, value);
}

export function failureCodeMetadata(code: FailureCode): FailureCodeMetadata {
  return METADATA[code];
}
