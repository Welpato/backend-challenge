import { defineEntity, type InferEntity, p } from '@mikro-orm/core';
import { MoneyAmountType } from '@/shared/persistence/money.type';

/**
 * Record da tabela `wallet_ledger_entries` (append-only: o repositório só faz INSERT e SELECT).
 * Valores e saldos são `numeric(20,2)` como string, todos na moeda da coluna `currency`.
 */
export const LedgerEntryRecord = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.text(),
    amount: p.type(MoneyAmountType),
    currency: p.string().columnType('char(3)'),
    balanceBefore: p.type(MoneyAmountType),
    balanceAfter: p.type(MoneyAmountType),
    walletVersion: p.bigint('string'),
    createdAt: p.datetime().columnType('timestamptz'),
  },
});

export type LedgerEntryRecord = InferEntity<typeof LedgerEntryRecord>;
