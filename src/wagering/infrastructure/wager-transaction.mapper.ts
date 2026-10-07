import { type FailureCode, isFailureCode } from '@/shared/failure-code';
import { CorruptRecordError } from '@/shared/persistence/persistence.errors';
import {
  moneyFromColumns,
  nullToUndefined,
  optionalMoneyFromColumns,
  undefinedToNull,
} from '@/shared/persistence/record-conversion';
import { isWagerTransactionKind, type WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { WAGER_TRANSACTION_STATUSES, type WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import { WagerTransaction } from '@/wagering/domain/wager-transaction';
import type { WagerTransactionRecord } from '@/wagering/infrastructure/wager-transaction.record';

function toKind(value: string): WagerTransactionKind {
  if (!isWagerTransactionKind(value)) {
    throw new CorruptRecordError('Column wager_transactions.kind has an unknown value');
  }
  return value;
}

function toStatus(value: string): WagerTransactionStatus {
  const status = WAGER_TRANSACTION_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new CorruptRecordError('Column wager_transactions.status has an unknown value');
  }
  return status;
}

function toFailureCode(value: string | null | undefined): FailureCode | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isFailureCode(value)) {
    throw new CorruptRecordError('Column wager_transactions.failure_code has an unknown value');
  }
  return value;
}

/** Colunas que uma transição de domínio pode mudar (as mesmas que o `trg_tx_immutable` libera). */
export type WagerTransactionStateColumns = Pick<
  WagerTransactionRecord,
  | 'status'
  | 'referenceTransactionId'
  | 'failureCode'
  | 'processedAt'
  | 'balanceAfterAmount'
  | 'balanceAfterCurrency'
  | 'attempts'
  | 'nextAttemptAt'
  | 'updatedAt'
>;

/**
 * `wager_transactions` ↔ `WagerTransaction` (via `rehydrate`).
 * - o `payload_hash` vem do banco e não é recalculado;
 * - `balanceAfter` usa `balance_after_currency` (moeda da wallet), nunca a coluna `currency` da transação;
 * - `NULL` ↔ `undefined`.
 */
export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: toKind(record.kind),
      money: moneyFromColumns(record.amount, record.currency),
      referenceExternalTransactionId: nullToUndefined(record.referenceExternalTransactionId),
      correlationId: nullToUndefined(record.correlationId),
      createdAt: record.createdAt,
      status: toStatus(record.status),
      referenceTransactionId: nullToUndefined(record.referenceTransactionId),
      failureCode: toFailureCode(record.failureCode),
      processedAt: nullToUndefined(record.processedAt),
      balanceAfter: optionalMoneyFromColumns(
        record.balanceAfterAmount,
        record.balanceAfterCurrency,
        'wager_transactions.balance_after',
      ),
      attempts: record.attempts,
      nextAttemptAt: nullToUndefined(record.nextAttemptAt),
    });
  },

  /** Linha completa para o INSERT. `updated_at` = `created_at` (a linha nasce agora). */
  toRecord(tx: WagerTransaction): WagerTransactionRecord {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.toJSON().amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: undefinedToNull(tx.referenceExternalTransactionId),
      correlationId: undefinedToNull(tx.correlationId),
      createdAt: tx.createdAt,
      ...WagerTransactionMapper.toStateColumns(tx, tx.createdAt),
    };
  },

  /** Só o estado mutável, para o UPDATE de `save`. */
  toStateColumns(tx: WagerTransaction, updatedAt: Date): WagerTransactionStateColumns {
    const balanceAfter = tx.balanceAfter;
    return {
      status: tx.status,
      referenceTransactionId: undefinedToNull(tx.referenceTransactionId),
      failureCode: undefinedToNull(tx.failureCode),
      processedAt: undefinedToNull(tx.processedAt),
      balanceAfterAmount: balanceAfter === undefined ? null : balanceAfter.toJSON().amount,
      balanceAfterCurrency: balanceAfter === undefined ? null : balanceAfter.currency,
      attempts: tx.attempts,
      nextAttemptAt: undefinedToNull(tx.nextAttemptAt),
      updatedAt: new Date(updatedAt.getTime()),
    };
  },
};
