import { DomainError } from '@/shared/errors/domain-error';

/**
 * Evento de integração montado com dados inválidos (id vazio, data inválida, transação no status
 * errado para o evento, `data` que não é JSON estável). Sempre erro de programação.
 */
export class InvalidIntegrationEventError extends DomainError {
  constructor(message: string, options?: ErrorOptions) {
    super('INVALID_INTEGRATION_EVENT', message, options);
  }
}
