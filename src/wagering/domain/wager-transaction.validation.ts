import { FailureCode } from '@/shared/failure-code';
import { Money } from '@/shared/money/money';
import { isWagerTransactionKind, WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import type { CreateWagerTransactionProps } from '@/wagering/domain/wager-transaction.state';
import { InvalidWagerTransactionError } from '@/wagering/domain/wagering.errors';

const REQUIRED_TEXT_FIELDS = [
  'providerId',
  'externalTransactionId',
  'idempotencyKey',
  'walletId',
  'playerId',
  'roundId',
  'gameId',
] as const;

/**
 * Regras de entrada de uma transação (ESPECIFICACAO.md §3.3/§3.7). Falhas lançam
 * `InvalidWagerTransactionError` com `VALIDATION_ERROR` (contrato → 400 / DLQ). A regra
 * "OPENING não pode ser submetido" (`KIND_NOT_ALLOWED`) fica em `WagerTransaction.create`, porque
 * `createOpening` reutiliza esta validação.
 */
export function assertValidTransactionInput(props: CreateWagerTransactionProps): void {
  const invalid = (message: string) => new InvalidWagerTransactionError(FailureCode.VALIDATION_ERROR, message);
  if (props.id !== undefined && (typeof props.id !== 'string' || props.id.length === 0)) {
    throw invalid('Invalid transaction: id must not be empty');
  }
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (typeof props[field] !== 'string' || props[field].length === 0) {
      throw invalid(`Invalid transaction: ${field} is required`);
    }
  }
  if (!isWagerTransactionKind(props.kind)) {
    throw invalid('Invalid transaction: unknown kind');
  }
  if (!(props.money instanceof Money) || props.money.isNegative()) {
    throw invalid('Invalid transaction: money must be a non-negative amount');
  }
  if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
    throw invalid(`Invalid transaction: ${props.kind} requires a positive amount`);
  }
  const reference = props.referenceExternalTransactionId;
  if (reference !== undefined && (typeof reference !== 'string' || reference.length === 0)) {
    throw invalid('Invalid transaction: referenceExternalTransactionId must not be empty');
  }
  if (
    reference === undefined &&
    (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback)
  ) {
    throw invalid(`Invalid transaction: ${props.kind} requires referenceExternalTransactionId`);
  }
  if (reference !== undefined && reference === props.externalTransactionId) {
    throw invalid('Invalid transaction: a transaction cannot reference itself');
  }
  if (!(props.at instanceof Date) || Number.isNaN(props.at.getTime())) {
    throw invalid('Invalid transaction: createdAt must be a valid date');
  }
}
