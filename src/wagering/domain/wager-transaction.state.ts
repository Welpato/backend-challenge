import type { FailureCode } from '@/shared/failure-code';
import type { Money } from '@/shared/money/money';
import type { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import type { WagerTransactionStatus } from '@/wagering/domain/transaction-status';

/** Entrada de `WagerTransaction.create` (operação vinda de um provedor por HTTP ou SQS). */
export interface CreateWagerTransactionProps {
  /** Id interno; gerado (UUID v7) quando ausente. */
  id?: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id da transação referenciada **no provedor** (não o id interno). */
  referenceExternalTransactionId?: string | undefined;
  correlationId?: string | undefined;
  at: Date;
}

/** Entrada de `WagerTransaction.createOpening` (crédito de abertura da wallet, interno). */
export interface CreateOpeningTransactionProps {
  id?: string;
  walletId: string;
  playerId: string;
  /** Saldo inicial (> 0). */
  money: Money;
  correlationId?: string | undefined;
  at: Date;
}

/** Estado completo persistido (reidratação). */
export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  correlationId?: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  /** Id interno da transação referenciada, preenchido ao processar. */
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  /** Momento da finalização (PROCESSED, REJECTED ou FAILED). */
  processedAt?: Date | undefined;
  /**
   * Saldo da wallet observado na finalização — devolvido nos replays (regra 7.7). Fica sempre na
   * **moeda da wallet**: em `CURRENCY_MISMATCH` difere de `money.currency` (persistido em
   * `balance_after_amount` + `balance_after_currency`).
   */
  balanceAfter?: Money | undefined;
  /** Tentativas de resolver a referência (contador, não dinheiro). */
  attempts: number;
  /** Próxima tentativa de resolver a referência; só em `PENDING_REFERENCE`. */
  nextAttemptAt?: Date | undefined;
}
