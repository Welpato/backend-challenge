import { CorruptRecordError } from '@/shared/persistence/persistence.errors';
import { fromSafeInteger, moneyFromColumns, toSafeInteger } from '@/shared/persistence/record-conversion';
import { LedgerDirection } from '@/wallet/domain/ledger-direction';
import { WalletLedgerEntry } from '@/wallet/domain/wallet-ledger-entry';
import type { LedgerEntryRecord } from '@/wallet/infrastructure/ledger-entry.record';

function toDirection(value: string): LedgerDirection {
  if (value === LedgerDirection.Debit || value === LedgerDirection.Credit) {
    return value;
  }
  throw new CorruptRecordError('Column wallet_ledger_entries.direction has an unknown value');
}

/** `wallet_ledger_entries` ↔ `WalletLedgerEntry` (via `rehydrate`, sem revalidar a aritmética). */
export const LedgerEntryMapper = {
  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: toDirection(record.direction),
      money: moneyFromColumns(record.amount, record.currency),
      balanceBefore: moneyFromColumns(record.balanceBefore, record.currency),
      balanceAfter: moneyFromColumns(record.balanceAfter, record.currency),
      walletVersion: toSafeInteger(record.walletVersion, 'wallet_ledger_entries.wallet_version'),
      createdAt: record.createdAt,
    });
  },

  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      walletVersion: fromSafeInteger(entry.walletVersion, 'walletVersion'),
      createdAt: new Date(entry.createdAt.getTime()),
    };
  },
};
