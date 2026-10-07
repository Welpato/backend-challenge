/** Status da transação de aposta (DESAFIO.md §6.3). */
export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. Não fica visível após o commit no fluxo síncrono. */
  Pending = 'PENDING',
  /** Aguardando a transação referenciada (reprocessada pelo worker agendado). */
  PendingReference = 'PENDING_REFERENCE',
  /** Aplicada (terminal). */
  Processed = 'PROCESSED',
  /** Violação de regra de negócio (terminal). */
  Rejected = 'REJECTED',
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = 'FAILED',
}

export const WAGER_TRANSACTION_STATUSES: readonly WagerTransactionStatus[] = Object.freeze(
  Object.values(WagerTransactionStatus),
);

/**
 * Tabela de transições válidas (ESPECIFICACAO.md §3.3). É a única fonte usada por
 * `WagerTransaction.assertCanTransition`:
 *
 * - `PENDING → PENDING_REFERENCE | PROCESSED | REJECTED | FAILED`
 * - `PENDING_REFERENCE → PENDING_REFERENCE (novo agendamento) | PROCESSED | REJECTED | FAILED`
 * - `PROCESSED`, `REJECTED`, `FAILED` são terminais: nenhuma saída. Tentar sair de um deles é erro
 *   de programação (`InvalidTransactionStateError`), não caminho de negócio.
 *
 * Nenhum estado volta para `PENDING`.
 */
export const WAGER_TRANSACTION_TRANSITIONS: Readonly<
  Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>
> = Object.freeze({
  [WagerTransactionStatus.Pending]: Object.freeze([
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ]),
  [WagerTransactionStatus.PendingReference]: Object.freeze([
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ]),
  [WagerTransactionStatus.Processed]: Object.freeze([]),
  [WagerTransactionStatus.Rejected]: Object.freeze([]),
  [WagerTransactionStatus.Failed]: Object.freeze([]),
});

export function canTransition(from: WagerTransactionStatus, to: WagerTransactionStatus): boolean {
  return WAGER_TRANSACTION_TRANSITIONS[from].includes(to);
}

/** Terminal = sem nenhuma transição de saída na tabela. */
export function isTerminalStatus(status: WagerTransactionStatus): boolean {
  return WAGER_TRANSACTION_TRANSITIONS[status].length === 0;
}
