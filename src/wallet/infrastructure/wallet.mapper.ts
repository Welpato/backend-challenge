import { fromSafeInteger, moneyFromColumns, toSafeInteger } from '@/shared/persistence/record-conversion';
import { Wallet } from '@/wallet/domain/wallet';
import type { WalletRecord } from '@/wallet/infrastructure/wallet.record';

/** `wallets` ↔ `Wallet`. A moeda da wallet é `balance.currency` (o domínio não tem campo próprio). */
export const WalletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      balance: moneyFromColumns(record.balance, record.currency),
      version: toSafeInteger(record.version, 'wallets.version'),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },

  toRecord(wallet: Wallet): WalletRecord {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: fromSafeInteger(wallet.version, 'version'),
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  },
};
