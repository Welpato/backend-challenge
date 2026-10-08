import { LockMode } from '@mikro-orm/core';
import type { OutboxRepository, OutboxStats } from '@/messaging/outbox/application/outbox.repository.port';
import { OutboxMessageMapper } from '@/messaging/outbox/infrastructure/outbox-message.mapper';
import { OutboxMessageRecord } from '@/messaging/outbox/infrastructure/outbox-message.record';
import type { OutboxMessage } from '@/messaging/outbox/outbox-message';
import type { Clock } from '@/shared/clock';
import { ConcurrencyInvariantError } from '@/shared/persistence/persistence.errors';
import { UNTRACKED } from '@/shared/persistence/read-options';
import { assertPositiveInteger } from '@/shared/persistence/record-conversion';
import type { UnitOfWork } from '@/shared/persistence/unit-of-work';

/** `OutboxRepository` sobre o MikroORM. Usa o `EntityManager` da `UnitOfWork` corrente. */
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.uow.em.insertMany(
      OutboxMessageRecord,
      messages.map((message) => OutboxMessageMapper.toRecord(message)),
    );
  }

  async claimDue(limit: number): Promise<OutboxMessage[]> {
    assertPositiveInteger(limit, 'limit');
    const records = await this.uow.em.find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: this.clock.now() } },
      { ...UNTRACKED, orderBy: { occurredAt: 'asc', id: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return records.map((record) => OutboxMessageMapper.toDomain(record));
  }

  async save(message: OutboxMessage): Promise<void> {
    const affected = await this.uow.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      OutboxMessageMapper.toPublicationColumns(message),
    );
    if (affected !== 1) {
      throw new ConcurrencyInvariantError(`Outbox message ${message.id} does not exist`);
    }
  }

  async stats(): Promise<OutboxStats> {
    const em = this.uow.em;
    // Sequencial: as duas queries usam a mesma conexão da transação.
    const pending = await em.count(OutboxMessageRecord, { publishedAt: null });
    const oldest = await em.findOne(
      OutboxMessageRecord,
      { publishedAt: null },
      { ...UNTRACKED, fields: ['occurredAt'], orderBy: { occurredAt: 'asc' } },
    );
    const oldestPendingOccurredAt = oldest?.occurredAt;
    const oldestPendingAgeSeconds =
      oldestPendingOccurredAt === undefined
        ? 0
        : Math.max(0, (this.clock.now().getTime() - oldestPendingOccurredAt.getTime()) / 1000);
    return { pending, oldestPendingOccurredAt, oldestPendingAgeSeconds };
  }

  countPendingOverAttempts(threshold: number): Promise<number> {
    return this.uow.em.count(OutboxMessageRecord, { publishedAt: null, attempts: { $gt: threshold } });
  }
}
