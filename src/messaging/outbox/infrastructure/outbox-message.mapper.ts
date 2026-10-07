import type { OutboxMessageRecord } from '@/messaging/outbox/infrastructure/outbox-message.record';
import { OutboxMessage } from '@/messaging/outbox/outbox-message';
import { nullToUndefined, undefinedToNull } from '@/shared/persistence/record-conversion';

/** Colunas de publicação — as únicas que o `trg_outbox_immutable` deixa mudar. */
export type OutboxPublicationColumns = Pick<
  OutboxMessageRecord,
  'attempts' | 'nextAttemptAt' | 'publishedAt' | 'lastError'
>;

/** `outbox_messages` ↔ `OutboxMessage` (via `rehydrate`; `payload` jsonb já chega como objeto). */
export const OutboxMessageMapper = {
  toDomain(record: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      eventVersion: record.eventVersion,
      payload: record.payload,
      correlationId: nullToUndefined(record.correlationId),
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt,
      publishedAt: nullToUndefined(record.publishedAt),
      lastError: nullToUndefined(record.lastError),
    });
  },

  toRecord(message: OutboxMessage): OutboxMessageRecord {
    return {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      eventVersion: message.eventVersion,
      payload: { ...message.payload },
      correlationId: undefinedToNull(message.correlationId),
      occurredAt: message.occurredAt,
      ...OutboxMessageMapper.toPublicationColumns(message),
    };
  },

  toPublicationColumns(message: OutboxMessage): OutboxPublicationColumns {
    return {
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
      publishedAt: undefinedToNull(message.publishedAt),
      lastError: undefinedToNull(message.lastError),
    };
  },
};
