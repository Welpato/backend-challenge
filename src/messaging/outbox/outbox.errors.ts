import { DomainError } from '@/shared/errors/domain-error';

/** Uso incorreto de `OutboxMessage` (ex.: publicar ou reagendar uma mensagem já publicada). */
export class InvalidOutboxOperationError extends DomainError {
  constructor(message: string) {
    super('INVALID_OUTBOX_OPERATION', message);
  }
}
