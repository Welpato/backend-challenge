import { DomainError } from '@/shared/errors/domain-error';

/** Uso incorreto de `InboxMessage` (dados inválidos ou `markProcessed` em mensagem já processada). */
export class InvalidInboxOperationError extends DomainError {
  constructor(message: string) {
    super('INVALID_INBOX_OPERATION', message);
  }
}

/**
 * A mesma mensagem (`consumerName`, `messageId`) chegou de novo com outro conteúdo (hash diferente). Não é
 * redelivery: é um produtor reaproveitando o id. Falha permanente — o consumidor manda para a DLQ.
 */
export class InboxPayloadConflictError extends DomainError {
  constructor(
    readonly consumerName: string,
    readonly messageId: string,
  ) {
    super('INBOX_CONFLICT', `Message ${messageId} was already received by ${consumerName} with a different payload`);
  }
}
