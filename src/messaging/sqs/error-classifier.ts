import { InboxPayloadConflictError } from '@/messaging/inbox/inbox.errors';
import { InvalidEnvelopeError } from '@/messaging/sqs/message-envelope';
import { isTransientSqsError } from '@/messaging/sqs/sqs.client';
import { DomainError } from '@/shared/errors/domain-error';
import { FailureCode, failureCodeMetadata, isFailureCode } from '@/shared/failure-code';
import { isTransientDatabaseError } from '@/shared/persistence/pg-errors';

/**
 * Destino de uma mensagem cujo processamento lançou (ESPECIFICACAO.md §7):
 * - `business-done`: desfecho de negócio terminal já decidido — ack (não volta, não vai para a DLQ);
 * - `transient`: sem ack; `ChangeMessageVisibility` com backoff; o redrive do SQS leva para a DLQ depois de
 *   `maxReceiveCount` recebimentos;
 * - `permanent`: nunca vai dar certo — DLQ explícita (com o motivo) e delete.
 */
export type ErrorClass = 'business-done' | 'transient' | 'permanent';

export interface ErrorClassification {
  readonly class: ErrorClass;
  /** Código curto: atributo `failureReason` da DLQ e label `reason` da métrica. Nunca contém dados da mensagem. */
  readonly reason: string;
}

/** Erro inesperado (bug, invariante violada): repetido até o redrive; não é tratado como permanente de cara. */
export const UNEXPECTED_ERROR_REASON = 'UNEXPECTED_ERROR';

/**
 * Tabela de §7:
 *
 * | Erro | Classe |
 * |---|---|
 * | envelope inválido, `type` desconhecido, `data` inválido (`InvalidEnvelopeError`) | permanente |
 * | mesmo `messageId` com outro conteúdo (`InboxPayloadConflictError`) | permanente |
 * | `FailureCode` de contrato (`VALIDATION_ERROR`, `KIND_NOT_ALLOWED` — OPENING), conflito (`IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT`) ou não encontrado (`WALLET_NOT_FOUND`) | permanente |
 * | `FailureCode` de negócio lançado como erro (defensivo: o use case grava REJECTED e devolve resultado) | negócio (ack) |
 * | PostgreSQL indisponível, deadlock, lock timeout, serialização (`classifyPgError`) | transitório |
 * | SQS indisponível/throttling (`isTransientSqsError`), `TRANSIENT_UNAVAILABLE` | transitório |
 * | `PROCESSING_FAILED`, código fora do catálogo, qualquer outro erro | transitório (`UNEXPECTED_ERROR`) |
 *
 * Erro inesperado é transitório de propósito: se for um soluço, a próxima entrega passa; se persistir, o
 * redrive limita as tentativas a `maxReceiveCount` e a mensagem chega à DLQ sem intervenção.
 */
export function classify(error: unknown): ErrorClassification {
  if (error instanceof InvalidEnvelopeError) {
    return { class: 'permanent', reason: error.reason };
  }
  if (error instanceof InboxPayloadConflictError) {
    return { class: 'permanent', reason: error.code };
  }
  if (isTransientDatabaseError(error)) {
    return { class: 'transient', reason: FailureCode.TRANSIENT_UNAVAILABLE };
  }
  if (error instanceof DomainError && isFailureCode(error.code)) {
    const meta = failureCodeMetadata(error.code);
    switch (meta.class) {
      case 'business':
        return { class: 'business-done', reason: error.code };
      case 'contract':
      case 'conflict':
      case 'not_found':
        return { class: 'permanent', reason: error.code };
      case 'transient':
        return { class: 'transient', reason: error.code };
      case 'infrastructure':
        return { class: 'transient', reason: UNEXPECTED_ERROR_REASON };
    }
  }
  if (isTransientSqsError(error)) {
    return { class: 'transient', reason: FailureCode.TRANSIENT_UNAVAILABLE };
  }
  return { class: 'transient', reason: UNEXPECTED_ERROR_REASON };
}
