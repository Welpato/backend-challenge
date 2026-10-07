import type { MoneyProps } from '@/shared/money/money-props';
import type { LedgerPage } from '@/wallet/application/get-ledger';
import type { ReconciliationReport } from '@/wallet/application/reconcile-wallet';
import type { LedgerDirection } from '@/wallet/domain/ledger-direction';
import type { Wallet } from '@/wallet/domain/wallet';
import type { WalletLedgerEntry } from '@/wallet/domain/wallet-ledger-entry';

/** Formato do enunciado (DESAFIO.md §9 "Criar wallet"). */
export interface WalletResponse {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export interface LedgerEntryResponse {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
  readonly createdAt: string;
}

export interface LedgerPageResponse {
  readonly items: readonly LedgerEntryResponse[];
  readonly nextCursor: string | null;
}

/** Formato do enunciado (DESAFIO.md §9 "Reconciliação"). */
export interface ReconciliationResponse {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export function toWalletResponse(wallet: Wallet): WalletResponse {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

export function toLedgerEntryResponse(entry: WalletLedgerEntry): LedgerEntryResponse {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function toLedgerPageResponse(page: LedgerPage): LedgerPageResponse {
  return { items: page.items.map(toLedgerEntryResponse), nextCursor: page.nextCursor };
}

export function toReconciliationResponse(report: ReconciliationReport): ReconciliationResponse {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
  };
}
