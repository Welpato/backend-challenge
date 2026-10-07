import { InvalidIntegrationEventError } from '@/shared/events/integration-event.errors';
import type { MoneyProps } from '@/shared/money/money-props';
import type { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import type { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';

/** Campos comuns aos eventos de `WagerTransaction` (identificação da operação e valor). */
export interface WagerTransactionEventBase {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
}

/**
 * Monta os campos comuns e garante que a transação está no status que o evento descreve
 * (emitir `Processed` para uma transação rejeitada é erro de programação).
 */
export function wagerTransactionEventBase(
  tx: WagerTransaction,
  expected: WagerTransactionStatus,
  eventType: string,
): WagerTransactionEventBase {
  if (tx.status !== expected) {
    throw new InvalidIntegrationEventError(`${eventType} requires a ${expected} transaction, got ${tx.status}`);
  }
  return {
    transactionId: tx.id,
    walletId: tx.walletId,
    playerId: tx.playerId,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
  };
}

/**
 * Chave de agregação dos eventos de transação: a **wallet**. A outbox publica em
 * `wallet-events.fifo` com `MessageGroupId = aggregateId`; agrupar por wallet mantém, para o
 * consumidor, a ordem entre `WagerTransaction*` e `WalletBalanceChanged` da mesma wallet.
 */
export function wagerTransactionAggregateId(tx: WagerTransaction): string {
  return tx.walletId;
}
