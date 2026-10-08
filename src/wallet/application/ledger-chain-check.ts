import { Money } from '@/shared/money/money';
import type { Wallet } from '@/wallet/domain/wallet';
import type { WalletLedgerEntry } from '@/wallet/domain/wallet-ledger-entry';

/** Códigos das verificações da reconciliação (ESPECIFICACAO.md §5 `ReconcileWallet`). */
export const ReconciliationIssue = {
  /** `wallet.balance` ≠ Σ créditos − Σ débitos. */
  BalanceMismatch: 'BALANCE_MISMATCH',
  /** Versões não contíguas, ou a primeira fora de 1 (abertura com saldo) / 2 (abertura com 0.00). */
  VersionGap: 'VERSION_GAP',
  /** `entry[n].balanceBefore` ≠ `entry[n-1].balanceAfter` (ou ≠ 0 no primeiro). */
  ChainBroken: 'CHAIN_BROKEN',
  /** Lançamento cuja aritmética não fecha. */
  EntryUnbalanced: 'ENTRY_UNBALANCED',
  /** Lançamento em moeda diferente da wallet. */
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  /** Último lançamento ≠ saldo/versão da wallet (ou wallet sem lançamentos com saldo ≠ 0). */
  LastEntryMismatch: 'LAST_ENTRY_MISMATCH',
  /** Contagem do agregado ≠ lançamentos percorridos na cadeia. */
  EntryCountMismatch: 'ENTRY_COUNT_MISMATCH',
} as const;

export type ReconciliationIssue = (typeof ReconciliationIssue)[keyof typeof ReconciliationIssue];

export interface ChainCheckResult {
  readonly checkedEntries: number;
  readonly issues: ReadonlySet<ReconciliationIssue>;
}

/**
 * Versão do primeiro lançamento. A wallet nasce com `version = 1` (§6.2) e a versão só muda com o saldo:
 * - aberta com saldo inicial → o crédito de abertura (OPENING) faz parte da criação e tem `walletVersion = 1`;
 * - aberta com `0.00` → não há lançamento de abertura; a primeira movimentação leva a wallet para a versão 2.
 * Nos dois casos o primeiro lançamento parte de saldo zero — o encadeamento (`balanceBefore` = 0) continua
 * conferido abaixo, então aceitar 2 não esconde um primeiro lançamento perdido.
 */
const FIRST_ENTRY_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

/**
 * Percorre a cadeia do ledger em ordem de `wallet_version` e confere: versões contíguas desde a primeira
 * (1 ou 2, ver `FIRST_ENTRY_VERSIONS`), cada
 * `balanceBefore` igual ao `balanceAfter` anterior (0 no primeiro), aritmética de cada lançamento, moeda e,
 * no fim, o último lançamento contra a wallet. Só lê — nunca corrige.
 */
export async function checkLedgerChain(
  wallet: Wallet,
  chain: AsyncIterable<WalletLedgerEntry>,
): Promise<ChainCheckResult> {
  const issues = new Set<ReconciliationIssue>();
  let expectedVersion: number | undefined;
  let previousAfter = Money.zero(wallet.currency);
  let last: WalletLedgerEntry | undefined;
  let checkedEntries = 0;
  for await (const entry of chain) {
    const versionOk =
      expectedVersion === undefined
        ? FIRST_ENTRY_VERSIONS.has(entry.walletVersion)
        : entry.walletVersion === expectedVersion;
    if (!versionOk) {
      issues.add(ReconciliationIssue.VersionGap);
    }
    if (entry.money.currency !== wallet.currency || entry.balanceBefore.currency !== wallet.currency) {
      issues.add(ReconciliationIssue.CurrencyMismatch);
    } else if (!entry.balanceBefore.equals(previousAfter)) {
      issues.add(ReconciliationIssue.ChainBroken);
    }
    if (!entry.isBalanced()) {
      issues.add(ReconciliationIssue.EntryUnbalanced);
    }
    previousAfter = entry.balanceAfter;
    expectedVersion = entry.walletVersion + 1;
    last = entry;
    checkedEntries += 1;
  }
  if (last === undefined) {
    if (!wallet.balance.isZero()) {
      issues.add(ReconciliationIssue.LastEntryMismatch);
    }
  } else if (
    last.balanceAfter.currency !== wallet.currency ||
    !last.balanceAfter.equals(wallet.balance) ||
    last.walletVersion !== wallet.version
  ) {
    issues.add(ReconciliationIssue.LastEntryMismatch);
  }
  return { checkedEntries, issues };
}
