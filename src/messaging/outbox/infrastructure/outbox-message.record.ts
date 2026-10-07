import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/**
 * Record da tabela `outbox_messages`. `id` = `eventId`; `payload` (jsonb) é o envelope do evento
 * (`IntegrationEvent.toJSON()`), com dinheiro sempre como `MoneyProps` (string). Só o estado de
 * publicação é atualizável (`trg_outbox_immutable`).
 */
export const OutboxMessageRecord = defineEntity({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.text(),
    eventType: p.text(),
    eventVersion: p.integer(),
    payload: p.json<Record<string, unknown>>().columnType('jsonb'),
    correlationId: p.text().nullable(),
    occurredAt: p.datetime().columnType('timestamptz'),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().columnType('timestamptz'),
    publishedAt: p.datetime().columnType('timestamptz').nullable(),
    lastError: p.text().nullable(),
  },
});

export type OutboxMessageRecord = InferEntity<typeof OutboxMessageRecord>;
