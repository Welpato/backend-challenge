/** Tipos de transação de aposta (DESAFIO.md §6.3). */
export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca aceito pela API nem pela fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export const WAGER_TRANSACTION_KINDS: readonly WagerTransactionKind[] = Object.freeze(
  Object.values(WagerTransactionKind),
);

export function isWagerTransactionKind(value: unknown): value is WagerTransactionKind {
  return typeof value === 'string' && (WAGER_TRANSACTION_KINDS as readonly string[]).includes(value);
}
