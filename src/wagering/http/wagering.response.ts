import type { FailureCode } from '@/shared/failure-code';
import type { MoneyProps } from '@/shared/money/money-props';
import type { ProcessResult } from '@/wagering/application/process-wager-transaction';
import type { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';

/**
 * Corpo de `POST /wagering/transactions` (ESPECIFICACAO.md §6): `{ transactionId, status, failureCode?, balance,
 * idempotentReplay }`. `balance` é o snapshot gravado (o mesmo em todos os replays); ausente em
 * `PENDING_REFERENCE`/`FAILED`, que não têm snapshot.
 */
export interface SubmitTransactionResponse {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly failureCode?: FailureCode;
  readonly balance?: MoneyProps;
  readonly idempotentReplay: boolean;
}

/**
 * Status HTTP por resultado (§6): PROCESSED 201 (nova) / 200 (replay) · PENDING_REFERENCE 202 · REJECTED 422
 * (nova ou replay, com `failureCode`) · FAILED 500 (só em replay de transação que esgotou as tentativas).
 */
export function httpStatusForResult(result: ProcessResult): number {
  switch (result.outcome) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

export function toSubmitTransactionResponse(result: ProcessResult): SubmitTransactionResponse {
  const { transaction, balance, idempotentReplay } = result;
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
    ...(balance === undefined ? {} : { balance: balance.toJSON() }),
    idempotentReplay,
  };
}

/** Visão completa de uma transação (consultas `GET`). Campos ausentes são omitidos. */
export interface TransactionResponse {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly status: WagerTransactionStatus;
  readonly failureCode?: FailureCode;
  readonly referenceExternalTransactionId?: string;
  readonly referenceTransactionId?: string;
  readonly balanceAfter?: MoneyProps;
  readonly attempts: number;
  readonly nextAttemptAt?: string;
  readonly createdAt: string;
  readonly processedAt?: string;
}

/** A `Idempotency-Key` e o `payloadHash` não são expostos (detalhes internos de idempotência). */
export function toTransactionResponse(tx: WagerTransaction): TransactionResponse {
  const {
    failureCode,
    referenceExternalTransactionId,
    referenceTransactionId,
    balanceAfter,
    nextAttemptAt,
    processedAt,
  } = tx;
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
    ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
    ...(balanceAfter === undefined ? {} : { balanceAfter: balanceAfter.toJSON() }),
    attempts: tx.attempts,
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt: nextAttemptAt.toISOString() }),
    createdAt: tx.createdAt.toISOString(),
    ...(processedAt === undefined ? {} : { processedAt: processedAt.toISOString() }),
  };
}
