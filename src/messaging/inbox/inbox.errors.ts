import { DomainError } from '@/shared/errors/domain-error';

/** Uso incorreto de `InboxMessage` (dados inválidos ou `markProcessed` em mensagem já processada). */
export class InvalidInboxOperationError extends DomainError {
  constructor(message: string) {
    super('INVALID_INBOX_OPERATION', message);
  }
}
