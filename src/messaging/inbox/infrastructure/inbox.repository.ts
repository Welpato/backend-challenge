import type { InboxInsertResult, InboxRepository } from '@/messaging/inbox/application/inbox.repository.port';
import type { InboxMessage } from '@/messaging/inbox/inbox-message';
import { InboxMessageMapper } from '@/messaging/inbox/infrastructure/inbox-message.mapper';
import { InboxMessageRecord } from '@/messaging/inbox/infrastructure/inbox-message.record';
import { ConcurrencyInvariantError } from '@/shared/persistence/persistence.errors';
import { UNTRACKED } from '@/shared/persistence/read-options';
import type { UnitOfWork } from '@/shared/persistence/unit-of-work';

/** `InboxRepository` sobre o MikroORM. Usa o `EntityManager` da `UnitOfWork` corrente. */
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly uow: UnitOfWork) {}

  /** Mesma técnica da transação: entrega concorrente da mesma mensagem espera na PK até o vencedor commitar. */
  async insertIfAbsent(message: InboxMessage): Promise<InboxInsertResult> {
    const rows = await this.uow.em
      .createQueryBuilder(InboxMessageRecord)
      .insert(InboxMessageMapper.toRecord(message))
      .onConflict()
      .ignore()
      .returning('messageId')
      .execute('all');
    if (rows.length === 1) {
      return { inserted: true };
    }
    const existing = await this.uow.em.findOne(
      InboxMessageRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      UNTRACKED,
    );
    if (existing === null) {
      throw new ConcurrencyInvariantError(
        `Inbox insert for message ${message.messageId} was skipped by a conflict, but no row is visible`,
      );
    }
    return { inserted: false, existing: InboxMessageMapper.toDomain(existing) };
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    const processedAt = message.processedAt;
    if (processedAt === undefined) {
      throw new ConcurrencyInvariantError(`Inbox message ${message.messageId} was not marked as processed`);
    }
    const affected = await this.uow.em.nativeUpdate(
      InboxMessageRecord,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyInvariantError(`Inbox message ${message.messageId} does not exist`);
    }
  }
}
