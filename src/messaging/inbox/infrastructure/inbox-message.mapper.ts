import { InboxMessage } from '@/messaging/inbox/inbox-message';
import type { InboxMessageRecord } from '@/messaging/inbox/infrastructure/inbox-message.record';
import { nullToUndefined, undefinedToNull } from '@/shared/persistence/record-conversion';

/** `inbox_messages` ↔ `InboxMessage` (via `rehydrate`). */
export const InboxMessageMapper = {
  toDomain(record: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: nullToUndefined(record.processedAt),
    });
  },

  toRecord(message: InboxMessage): InboxMessageRecord {
    return {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: undefinedToNull(message.processedAt),
    };
  },
};
