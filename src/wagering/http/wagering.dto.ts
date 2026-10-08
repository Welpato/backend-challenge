import { z } from 'zod';
import { FailureCode } from '@/shared/failure-code';
import { ApiError, RequestValidationError } from '@/shared/http/api-error';
import { moneyInputSchema } from '@/shared/http/money.schema';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';

/** Limite do header `Idempotency-Key` (F09). */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const IDENTIFIER_MAX_LENGTH = 255;

const identifier = z
  .string('must be a string')
  .min(1, 'must not be empty')
  .max(IDENTIFIER_MAX_LENGTH, `must have at most ${IDENTIFIER_MAX_LENGTH} characters`)
  .refine((value) => value.trim() === value, 'must not have leading or trailing whitespace');

/**
 * `POST /wagering/transactions` (DESAFIO.md §9). `kind` aceita todos os tipos conhecidos, inclusive `OPENING`:
 * a recusa de `OPENING` é do domínio (`KIND_NOT_ALLOWED`, 400), não "valor desconhecido". Regras que dependem
 * do kind (valor > 0, referência obrigatória) também ficam no domínio (`VALIDATION_ERROR`). Campos extras → 400.
 */
export const submitTransactionBodySchema = z
  .object({
    providerId: identifier,
    externalTransactionId: identifier,
    playerId: identifier,
    walletId: z.uuid('must be a UUID'),
    roundId: identifier,
    gameId: identifier,
    kind: z.enum(WagerTransactionKind, 'must be a known transaction kind'),
    money: moneyInputSchema,
    referenceExternalTransactionId: identifier.optional(),
  })
  .strict();

export type SubmitTransactionBody = z.output<typeof submitTransactionBodySchema>;

/**
 * Header `Idempotency-Key`: obrigatório (ausente ou vazio → 400 `MISSING_IDEMPOTENCY_KEY`), até 200
 * caracteres e sem espaços nas pontas (→ 400 `VALIDATION_ERROR`). O valor é usado como está — é a fonte da
 * verdade da idempotência.
 */
export function parseIdempotencyKey(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value.length === 0) {
    throw new ApiError(400, FailureCode.MISSING_IDEMPOTENCY_KEY, 'Idempotency-Key header is required');
  }
  if (Array.isArray(header) && header.length > 1) {
    throw new RequestValidationError([{ path: 'Idempotency-Key', message: 'must be sent once' }]);
  }
  if (value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new RequestValidationError([
      { path: 'Idempotency-Key', message: `must have at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters` },
    ]);
  }
  if (value.trim() !== value) {
    throw new RequestValidationError([
      { path: 'Idempotency-Key', message: 'must not have leading or trailing whitespace' },
    ]);
  }
  return value;
}

export const transactionIdParamSchema = z.uuid('must be a UUID');
export const providerIdParamSchema = identifier;
export const externalTransactionIdParamSchema = identifier;
