import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/** Record da tabela `inbox_messages` (PK composta `consumer_name` + `message_id`; sem DELETE). */
export const InboxMessageRecord = defineEntity({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.string().columnType('char(64)'),
    receivedAt: p.datetime().columnType('timestamptz'),
    processedAt: p.datetime().columnType('timestamptz').nullable(),
  },
});

export type InboxMessageRecord = InferEntity<typeof InboxMessageRecord>;
