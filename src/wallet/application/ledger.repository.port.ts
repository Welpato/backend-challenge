import type { WalletLedgerEntry } from '@/wallet/domain/wallet-ledger-entry';

export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');

/** Somas do ledger de uma wallet por direção, em string `NUMERIC` exata (sem `number`). */
export interface LedgerTotals {
  readonly walletId: string;
  /** Σ CREDIT, ex.: `"1000.00"`; `"0.00"` sem lançamentos. */
  readonly credits: string;
  /** Σ DEBIT, ex.: `"25.00"`; `"0.00"` sem lançamentos. */
  readonly debits: string;
  readonly entries: number;
}

/** Porta do ledger (append-only: não existe update nem delete). */
export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Keyset por `wallet_version`: lançamentos com versão `> afterVersion`, em ordem crescente, até `limit`. */
  page(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
  aggregate(walletId: string): Promise<LedgerTotals>;
  /** Todos os lançamentos em ordem de `wallet_version`, lidos em lotes (verificação de cadeia). */
  chain(walletId: string): AsyncIterable<WalletLedgerEntry>;
}
