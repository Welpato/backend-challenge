import { defineEntity, type InferEntity, p } from '@mikro-orm/core';
import { MoneyAmountType } from '@/shared/persistence/money.type';

/**
 * Record da tabela `wager_transactions`. Colunas de negócio são imutáveis no banco (`trg_tx_immutable`);
 * o repositório só atualiza o estado mutável (status, referência interna, código de falha, snapshot,
 * tentativas, agendamento, datas). `balance_after_*` é o snapshot na moeda **da wallet**.
 */
export const WagerTransactionRecord = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.string().columnType('char(64)'),
    walletId: p.uuid(),
    playerId: p.text(),
    roundId: p.text(),
    gameId: p.text(),
    kind: p.text(),
    amount: p.type(MoneyAmountType),
    currency: p.string().columnType('char(3)'),
    referenceExternalTransactionId: p.text().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.text(),
    failureCode: p.text().nullable(),
    balanceAfterAmount: p.type(MoneyAmountType).nullable(),
    balanceAfterCurrency: p.string().columnType('char(3)').nullable(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().columnType('timestamptz').nullable(),
    correlationId: p.text().nullable(),
    createdAt: p.datetime().columnType('timestamptz'),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
    updatedAt: p.datetime().columnType('timestamptz'),
  },
});

export type WagerTransactionRecord = InferEntity<typeof WagerTransactionRecord>;
