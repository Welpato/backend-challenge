import {
  ChangeMessageVisibilityBatchCommand,
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '@/config/load-config';
import { createSqsClient } from '@/messaging/sqs/sqs.client';

/**
 * Helpers de SQS para os testes (LocalStack/emulador real da infra de teste — nada mockado): filas FIFO
 * isoladas por teste, leitura completa (drain) e um consumidor de exemplo que deduplica por `eventId`.
 */
let client: SQSClient | undefined;

export function testSqsClient(): SQSClient {
  client ??= createSqsClient(loadConfig());
  return client;
}

export interface IsolatedQueue {
  readonly name: string;
  readonly url: string;
}

/** Fila FIFO nova, com nome único (`t-<prefixo>-<aleatório>.fifo`), mesmos atributos da `wallet-events.fifo`. */
export async function createIsolatedQueue(prefix: string): Promise<IsolatedQueue> {
  const name = `t-${prefix}-${crypto.randomUUID().slice(0, 8)}.fifo`;
  const output = await testSqsClient().send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '30' },
    }),
  );
  if (output.QueueUrl === undefined) {
    throw new Error(`Queue ${name} was not created`);
  }
  return { name, url: output.QueueUrl };
}

export async function deleteQueue(queue: IsolatedQueue): Promise<void> {
  await testSqsClient().send(new DeleteQueueCommand({ QueueUrl: queue.url }));
}

/** Uma rodada de `ReceiveMessage` (até 10), com atributos. Não apaga. */
export async function receive(queue: IsolatedQueue, waitTimeSeconds = 0): Promise<Message[]> {
  const output = await testSqsClient().send(
    new ReceiveMessageCommand({
      QueueUrl: queue.url,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitTimeSeconds,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
    }),
  );
  return output.Messages ?? [];
}

/** Devolve mensagens recebidas para a fila imediatamente (redelivery at-least-once, sem esperar o visibility timeout). */
export async function releaseForRedelivery(queue: IsolatedQueue, messages: readonly Message[]): Promise<void> {
  if (messages.length === 0) {
    return;
  }
  await testSqsClient().send(
    new ChangeMessageVisibilityBatchCommand({
      QueueUrl: queue.url,
      Entries: messages.map((message, index) => ({
        Id: String(index),
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: 0,
      })),
    }),
  );
}

/**
 * Lê e apaga tudo da fila até `emptyRounds` recebimentos vazios seguidos. Em FIFO, uma mensagem de um grupo só
 * é entregue depois que as anteriores do mesmo grupo foram apagadas — por isso apaga a cada rodada.
 */
export async function drainQueue(queue: IsolatedQueue, emptyRounds = 2): Promise<Message[]> {
  const all: Message[] = [];
  let empty = 0;
  while (empty < emptyRounds) {
    const batch = await receive(queue, 1);
    if (batch.length === 0) {
      empty += 1;
      continue;
    }
    empty = 0;
    all.push(...batch);
    await testSqsClient().send(
      new DeleteMessageBatchCommand({
        QueueUrl: queue.url,
        Entries: batch.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle })),
      }),
    );
  }
  return all;
}

export interface EventEnvelope {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: Record<string, unknown>;
}

export function envelopeOf(message: Message): EventEnvelope {
  return JSON.parse(message.Body ?? 'null') as EventEnvelope;
}

/**
 * Consumidor de exemplo (ESPECIFICACAO.md §8): aplica cada evento **uma vez** guardando os `eventId` já vistos.
 * Num consumidor real o conjunto é uma tabela com `UNIQUE (event_id)` na mesma transação da projeção (inbox);
 * aqui a projeção é o último saldo conhecido por wallet, a partir de `WalletBalanceChanged`.
 */
export class DedupByEventIdConsumer {
  private readonly seen = new Set<string>();
  readonly balances = new Map<string, { amount: string; version: number }>();
  applied = 0;
  duplicates = 0;

  consume(messages: readonly Message[]): void {
    for (const message of messages) {
      const event = envelopeOf(message);
      if (this.seen.has(event.eventId)) {
        this.duplicates += 1;
        continue;
      }
      this.seen.add(event.eventId);
      this.applied += 1;
      if (event.eventType === 'WalletBalanceChanged') {
        const data = event.data as { walletId: string; balanceAfter: { amount: string }; walletVersion: number };
        const current = this.balances.get(data.walletId);
        if (current === undefined || current.version < data.walletVersion) {
          this.balances.set(data.walletId, { amount: data.balanceAfter.amount, version: data.walletVersion });
        }
      }
    }
  }
}

export interface WagerQueues {
  readonly queue: IsolatedQueue;
  readonly dlq: IsolatedQueue;
  /** Ambiente para o consumidor (in-process ou subprocesso) usar estas filas. */
  readonly env: Record<string, string>;
}

/**
 * Par isolado `fila de entrada + DLQ` com o mesmo desenho da `wager-transactions.fifo` (FIFO, sem dedup por
 * conteúdo, redrive para a DLQ depois de `maxReceiveCount` recebimentos), com visibility timeout curto para a
 * redelivery dos testes de crash não esperar 30 s.
 */
export async function createWagerQueues(
  prefix: string,
  options: { maxReceiveCount?: number; visibilityTimeoutSeconds?: number } = {},
): Promise<WagerQueues> {
  const maxReceiveCount = options.maxReceiveCount ?? 5;
  const dlq = await createIsolatedQueue(`${prefix}-dlq`);
  const attributes = await testSqsClient().send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.url, AttributeNames: ['QueueArn'] }),
  );
  const dlqArn = attributes.Attributes?.QueueArn;
  if (dlqArn === undefined) {
    throw new Error(`No ARN for ${dlq.name}`);
  }
  const name = `t-${prefix}-${crypto.randomUUID().slice(0, 8)}.fifo`;
  const output = await testSqsClient().send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 30),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(maxReceiveCount) }),
      },
    }),
  );
  if (output.QueueUrl === undefined) {
    throw new Error(`Queue ${name} was not created`);
  }
  const queue = { name, url: output.QueueUrl };
  return {
    queue,
    dlq,
    env: {
      SQS_WAGER_QUEUE_NAME: queue.name,
      SQS_WAGER_DLQ_NAME: dlq.name,
      SQS_MAX_RECEIVE_COUNT: String(maxReceiveCount),
    },
  };
}

export async function deleteWagerQueues(queues: WagerQueues): Promise<void> {
  await Promise.all([deleteQueue(queues.queue), deleteQueue(queues.dlq)]);
}

/**
 * Envia um corpo para a fila. `groupId` default = a wallet do envelope (como os produtores, §7);
 * `deduplicationId` default = aleatório (cada envio é uma entrega distinta — duplicatas chegam ao consumidor).
 */
export async function sendRaw(
  queue: IsolatedQueue,
  body: string,
  options: { groupId?: string; deduplicationId?: string; correlationId?: string } = {},
): Promise<void> {
  await testSqsClient().send(
    new SendMessageCommand({
      QueueUrl: queue.url,
      MessageBody: body,
      MessageGroupId: options.groupId ?? 'test-group',
      MessageDeduplicationId: options.deduplicationId ?? crypto.randomUUID(),
      ...(options.correlationId === undefined
        ? {}
        : { MessageAttributes: { correlationId: { DataType: 'String', StringValue: options.correlationId } } }),
    }),
  );
}

export interface WagerEnvelopeInput {
  readonly messageId?: string;
  readonly type?: string;
  readonly occurredAt?: string;
  readonly data: Record<string, unknown> & { walletId: string };
}

/** Envelope `WagerTransactionRequested` (DESAFIO.md §10) como objeto, com defaults. */
export function wagerEnvelope(input: WagerEnvelopeInput): Record<string, unknown> {
  return {
    messageId: input.messageId ?? `msg-${crypto.randomUUID()}`,
    type: input.type ?? 'WagerTransactionRequested',
    occurredAt: input.occurredAt ?? '2026-07-29T15:00:00.000Z',
    data: input.data,
  };
}

export async function sendEnvelope(
  queue: IsolatedQueue,
  envelope: Record<string, unknown>,
  options: { deduplicationId?: string; correlationId?: string } = {},
): Promise<void> {
  const data = envelope.data as { walletId?: unknown } | undefined;
  await sendRaw(queue, JSON.stringify(envelope), {
    groupId: typeof data?.walletId === 'string' ? data.walletId : 'test-group',
    ...options,
  });
}

/** Mensagens visíveis + em voo (`ApproximateNumberOfMessages` + `…NotVisible`). */
export async function queueDepth(queue: IsolatedQueue): Promise<number> {
  const output = await testSqsClient().send(
    new GetQueueAttributesCommand({
      QueueUrl: queue.url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  const attributes = output.Attributes ?? {};
  return (
    Number(attributes.ApproximateNumberOfMessages ?? '0') +
    Number(attributes.ApproximateNumberOfMessagesNotVisible ?? '0')
  );
}
