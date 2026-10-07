import { defineEntity, type InferEntity, p } from '@mikro-orm/core';
import { MoneyAmountType } from '@/shared/persistence/money.type';

/**
 * Record da tabela `wallets` (infraestrutura; o domínio nunca vê este tipo).
 * `balance` é `numeric(20,2)` como string e `version` é `bigint` como string — os mappers convertem
 * para `Money` e `number` (com checagem de inteiro seguro).
 */
export const WalletRecord = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.text(),
    currency: p.string().columnType('char(3)'),
    balance: p.type(MoneyAmountType),
    version: p.bigint('string'),
    createdAt: p.datetime().columnType('timestamptz'),
    updatedAt: p.datetime().columnType('timestamptz'),
  },
});

export type WalletRecord = InferEntity<typeof WalletRecord>;
