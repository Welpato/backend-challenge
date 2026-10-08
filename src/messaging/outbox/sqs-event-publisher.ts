import { type MessageAttributeValue, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '@/messaging/outbox/event-publisher.port';
import type { OutboxMessage } from '@/messaging/outbox/outbox-message';
import { isTransientSqsError, type SqsQueueUrls } from '@/messaging/sqs/sqs.client';

/** Limite do `SendMessageBatch` do SQS. */
const SQS_BATCH_LIMIT = 10;

export interface SqsEventPublisherSettings {
  /** Nome da fila de saída (`wallet-events.fifo`). */
  readonly queueName: string;
  /** Tempo máximo de uma chamada ao SQS: o publisher segura os locks da outbox enquanto publica. */
  readonly requestTimeoutMs: number;
}

/**
 * Publica na fila FIFO de eventos (ESPECIFICACAO.md §8):
 * - `MessageGroupId = aggregateId` (a wallet): ordem por wallet para o consumidor;
 * - `MessageDeduplicationId = eventId`: o broker descarta reenvios dentro da janela de deduplicação (5 min) —
 *   otimização; a garantia é o consumidor deduplicar por `eventId`;
 * - corpo = envelope do evento (`payload` da outbox); atributos `eventType`, `eventVersion`, `correlationId`.
 *
 * Lotes de até 10 (limite do SQS). Falha da chamada inteira (rede, timeout, fila) marca todas as mensagens
 * daquela chamada como falhas; falhas parciais vêm por entrada (`Failed`).
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrls: SqsQueueUrls,
    private readonly settings: SqsEventPublisherSettings,
  ) {}

  async publishBatch(messages: readonly OutboxMessage[]): Promise<PublishResult[]> {
    const results: PublishResult[] = [];
    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      results.push(...(await this.sendChunk(messages.slice(start, start + SQS_BATCH_LIMIT))));
    }
    return results;
  }

  private async sendChunk(chunk: readonly OutboxMessage[]): Promise<PublishResult[]> {
    try {
      const signal = AbortSignal.timeout(this.settings.requestTimeoutMs);
      const queueUrl = await this.queueUrls.resolve(this.settings.queueName, signal);
      const output = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: attributesOf(message),
          })),
        }),
        { abortSignal: signal },
      );
      const failures = new Map((output.Failed ?? []).map((failure) => [failure.Id, failure]));
      return chunk.map((message, index): PublishResult => {
        const failure = failures.get(String(index));
        if (failure === undefined) {
          return { messageId: message.id, ok: true };
        }
        return {
          messageId: message.id,
          ok: false,
          error: `${failure.Code ?? 'Failed'}: ${failure.Message ?? 'entry rejected by SQS'}`,
          transient: failure.SenderFault !== true,
        };
      });
    } catch (error: unknown) {
      const description = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const transient = isTransientSqsError(error);
      return chunk.map((message) => ({ messageId: message.id, ok: false, error: description, transient }));
    }
  }
}

function attributesOf(message: OutboxMessage): Record<string, MessageAttributeValue> {
  return {
    eventType: { DataType: 'String', StringValue: message.eventType },
    eventVersion: { DataType: 'Number', StringValue: String(message.eventVersion) },
    ...(message.correlationId === undefined
      ? {}
      : { correlationId: { DataType: 'String', StringValue: message.correlationId } }),
  };
}
