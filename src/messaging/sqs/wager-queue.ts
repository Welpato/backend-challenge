import {
  ChangeMessageVisibilityBatchCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { backoffDelayMs } from '@/messaging/outbox/backoff';
import type { SqsQueueUrls } from '@/messaging/sqs/sqs.client';

/** Teto do `VisibilityTimeout` aceito pelo SQS (12 h). */
const MAX_VISIBILITY_SECONDS = 43_200;
/** O SQS entrega no máximo 10 mensagens por `ReceiveMessage`. */
export const MAX_MESSAGES_PER_RECEIVE = 10;

export interface WagerQueueSettings {
  readonly queueName: string;
  readonly dlqName: string;
  readonly waitTimeSeconds: number;
}

export interface RetryBackoff {
  readonly baseMs: number;
  readonly maxMs: number;
}

/**
 * Visibilidade (segundos) para a próxima tentativa depois de uma falha transitória: `base·2^(n−1)` com teto e
 * jitter para baixo (`backoff.ts`), onde `n` = `ApproximateReceiveCount` (1 na primeira entrega). Arredonda para
 * cima: nunca 0 (0 seria reentrega imediata, sem backoff).
 */
export function retryVisibilitySeconds(
  receiveCount: number,
  backoff: RetryBackoff,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.trunc(receiveCount) - 1);
  const ms = backoffDelayMs(exponent, { baseMs: backoff.baseMs, maxMs: backoff.maxMs, random });
  return Math.min(MAX_VISIBILITY_SECONDS, Math.max(1, Math.ceil(ms / 1000)));
}

/** `ApproximateReceiveCount` da mensagem (1 se o atributo não veio). */
export function receiveCountOf(message: Message): number {
  const raw = message.Attributes?.ApproximateReceiveCount;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

/** Grupo FIFO da mensagem; sem grupo (fila standard) cada mensagem é o próprio grupo. */
export function groupIdOf(message: Message): string {
  return message.Attributes?.MessageGroupId ?? message.MessageId ?? 'unknown';
}

/** Atributo de mensagem `String` (ex.: `correlationId` enviado pelo produtor). */
export function stringAttributeOf(message: Message, name: string): string | undefined {
  return message.MessageAttributes?.[name]?.StringValue;
}

/**
 * Operações do consumidor sobre a `wager-transactions.fifo` e a DLQ. Fina sobre o SDK: toda decisão (ack,
 * retry, DLQ) é do worker. As URLs vêm de `GetQueueUrl` (cacheadas).
 */
export class WagerQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrls: SqsQueueUrls,
    private readonly settings: WagerQueueSettings,
  ) {}

  /** Long-poll (`WaitTimeSeconds`, até `maxMessages` ≤ 10) com `ApproximateReceiveCount` e `MessageGroupId`. */
  async receive(abortSignal: AbortSignal, maxMessages = MAX_MESSAGES_PER_RECEIVE): Promise<Message[]> {
    const queueUrl = await this.queueUrls.resolve(this.settings.queueName, abortSignal);
    const output = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: Math.max(1, Math.min(MAX_MESSAGES_PER_RECEIVE, maxMessages)),
        WaitTimeSeconds: this.settings.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        MessageAttributeNames: ['All'],
      }),
      { abortSignal },
    );
    return output.Messages ?? [];
  }

  /** Ack: só depois do commit. */
  async delete(message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.queueUrls.resolve(this.settings.queueName),
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrls.resolve(this.settings.queueName),
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  /** Devolve mensagens para a fila imediatamente (shutdown: o que não terminou volta para outra instância). */
  async release(messages: readonly Message[]): Promise<void> {
    const queueUrl = await this.queueUrls.resolve(this.settings.queueName);
    for (let start = 0; start < messages.length; start += MAX_MESSAGES_PER_RECEIVE) {
      const chunk = messages.slice(start, start + MAX_MESSAGES_PER_RECEIVE);
      await this.client.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((message, index) => ({
            Id: String(index),
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          })),
        }),
      );
    }
  }

  /**
   * Falha permanente: copia a mensagem para a DLQ com o motivo (mesmo corpo, mesmo `MessageGroupId`), para
   * investigação/replay manual. Dedup pelo `MessageId` do SQS: se o delete da original falhar e ela voltar, o
   * reenvio à DLQ dentro de 5 min é descartado pelo broker.
   */
  async sendToDlq(message: Message, failureReason: string, originalMessageId: string): Promise<void> {
    const attributes: Record<string, { DataType: 'String'; StringValue: string }> = {
      failureReason: { DataType: 'String', StringValue: failureReason },
      originalMessageId: { DataType: 'String', StringValue: originalMessageId },
    };
    const correlationId = stringAttributeOf(message, 'correlationId');
    if (correlationId !== undefined) {
      attributes.correlationId = { DataType: 'String', StringValue: correlationId };
    }
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrls.resolve(this.settings.dlqName),
        MessageBody: message.Body === undefined || message.Body === '' ? '(empty)' : message.Body,
        MessageGroupId: groupIdOf(message),
        MessageDeduplicationId: message.MessageId ?? originalMessageId,
        MessageAttributes: attributes,
      }),
    );
  }
}
