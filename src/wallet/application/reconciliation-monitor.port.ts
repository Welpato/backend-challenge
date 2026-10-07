/** Divergência encontrada pela reconciliação (sem valores: logs não carregam dinheiro). */
export interface ReconciliationMismatch {
  readonly walletId: string;
  readonly checkedEntries: number;
  /** Códigos das verificações que falharam, ex.: `BALANCE_MISMATCH`, `CHAIN_BROKEN`. */
  readonly issues: readonly string[];
}

/** Observa divergências: log `warn` + contador `reconciliation_mismatches_total`. Nunca corrige nada. */
export interface ReconciliationMonitor {
  mismatch(mismatch: ReconciliationMismatch): void;
}

export const RECONCILIATION_MONITOR = Symbol('RECONCILIATION_MONITOR');
