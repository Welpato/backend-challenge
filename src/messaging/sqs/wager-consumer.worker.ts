import type { Message } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { classify } from '@/messaging/sqs/error-classifier';
import { InvalidEnvelopeError, parseWagerEnvelope } from '@/messaging/sqs/message-envelope';
import {
  groupIdOf,
  type RetryBackoff,
  receiveCountOf,
  retryVisibilitySeconds,
  stringAttributeOf,
  type WagerQueue,
} from '@/messaging/sqs/wager-queue';
import type { AppMetrics } from '@/shared/observability/app-metrics';
import { addLogContext, resolveCorrelationId, runWithCorrelation } from '@/shared/observability/correlation';
import type { ProcessResult, ProcessWagerTransaction } from '@/wagering/application/process-wager-transaction';

/** Nome do consumidor na inbox — o mesmo em todas as instâncias (a PK é `(consumer_name, message_id)`). */
export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';
/** Código de saída do fault hook `FAULT_EXIT_AFTER_COMMIT` (morte "por SIGKILL" entre commit e ack). */
export const CONSUMER_FAULT_EXIT_CODE = 137;
/** Espera depois de um `ReceiveMessage` que falhou (SQS fora) antes de tentar de novo. */
const RECEIVE_ERROR_DELAY_MS = 1000;

export interface WagerConsumerSettings {
  readonly shutdownGraceMs: number;
  /** Limite de mensagens recebidas e ainda não resolvidas; o long-poll só pede o que cabe. */
  readonly maxInFlight: number;
  readonly retryBackoff: RetryBackoff;
  /** Só testes: `process.exit(137)` depois do commit e antes do `DeleteMessage`. */
  readonly exitAfterCommit: boolean;
}

/**
 * Consumidor da `wager-transactions.fifo` (DESAFIO.md §10, ESPECIFICACAO.md §7), papel `consumer`.
 *
 * - Long-poll de até 10 mensagens; grupos (`MessageGroupId` = wallet) diferentes em paralelo, o mesmo grupo em
 *   sequência, na ordem recebida. O loop não espera o lote terminar para pedir o próximo (até `maxInFlight`
 *   mensagens em andamento): uma wallet lenta não segura as outras. A ordem dentro do grupo entre lotes é do
 *   próprio FIFO — o SQS não entrega a próxima mensagem de um grupo enquanto a anterior está em voo.
 * - Cada mensagem passa pelo **mesmo** `ProcessWagerTransaction` do HTTP, com a inbox na mesma transação SQL;
 *   `correlationId` = atributo `correlationId` (se válido) ou o `messageId`; `causationId` = `messageId`.
 * - Ack (`DeleteMessage`) só depois do commit: sucesso, rejeição de negócio, `PENDING_REFERENCE`, replay e
 *   duplicata de inbox. Se o processo morrer entre o commit e o ack, a redelivery cai na inbox (sem efeito).
 * - Transitório: sem ack, `ChangeMessageVisibility` com backoff pelo `ApproximateReceiveCount`; o redrive do
 *   SQS leva para a DLQ ao passar de `maxReceiveCount`. Permanente: cópia na DLQ com `failureReason` e
 *   `originalMessageId`, depois delete.
 * - SIGTERM: para o polling (abort do long-poll), não começa mensagens novas, espera as em andamento por até
 *   `SHUTDOWN_GRACE_MS` e devolve o que não terminou com visibilidade 0. A readiness já responde 503 desde o
 *   primeiro hook de shutdown. Depois o Nest fecha ORM e cliente SQS.
 *
 * Observabilidade: cada mensagem roda num contexto de log próprio (`correlationId`, `messageId`, `causationId` e,
 * depois do processamento, os ids da transação); a linha "Message processed"/de falha leva `durationMs`.
 * Métricas: `sqs_retries_total`, `sqs_dlq_messages_total{reason}`, `inbox_duplicates_total`.
 */
export class WagerConsumerWorker implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger('WagerConsumerWorker');
  private readonly abort = new AbortController();
  /** Recebidas e ainda não resolvidas (ack, retry ou DLQ) — o que o shutdown devolve à fila. */
  private readonly unsettled = new Map<string, Message>();
  private loopDone: Promise<void> | undefined;
  /** Lotes em processamento (o shutdown espera por eles até o prazo). */
  private readonly batches = new Set<Promise<void>>();
  /** Acorda o loop quando uma mensagem é resolvida e abre vaga (ou no shutdown). */
  private wakeLoop: (() => void) | undefined;
  private stopping = false;
  /** Depois de devolver as pendentes no shutdown, nenhuma chamada ao SQS (o cliente vai ser destruído). */
  private released = false;

  constructor(
    private readonly queue: WagerQueue,
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly settings: WagerConsumerSettings,
    private readonly metrics: AppMetrics,
  ) {}

  onApplicationBootstrap(): void {
    this.loopDone = this.loop();
  }

  /** Primeiro hook do shutdown: para de pedir mensagens já (o long-poll é abortado). */
  onModuleDestroy(): void {
    this.stopping = true;
    this.abort.abort();
    this.wakeLoop?.();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.onModuleDestroy();
    const drained = async (): Promise<boolean> => {
      await this.loopDone;
      await Promise.all([...this.batches]);
      return true;
    };
    const finished = await Promise.race([drained(), Bun.sleep(this.settings.shutdownGraceMs).then(() => false)]);
    const pending = [...this.unsettled.values()];
    this.released = true;
    if (pending.length > 0) {
      try {
        await this.queue.release(pending);
        this.logger.warn({ released: pending.length, finished }, 'Returned unfinished messages to the queue');
      } catch (error: unknown) {
        // Sem a devolução, o visibility timeout da fila devolve as mensagens sozinho.
        this.logger.error({ err: error, unfinished: pending.length }, 'Could not return unfinished messages');
      }
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const capacity = this.settings.maxInFlight - this.unsettled.size;
      if (capacity <= 0) {
        await new Promise<void>((resolve) => {
          this.wakeLoop = resolve;
        });
        this.wakeLoop = undefined;
        continue;
      }
      let messages: Message[];
      try {
        messages = await this.queue.receive(this.abort.signal, capacity);
      } catch (error: unknown) {
        if (this.stopping) {
          return;
        }
        this.logger.warn({ err: error }, 'Could not receive messages from SQS');
        await Bun.sleep(RECEIVE_ERROR_DELAY_MS);
        continue;
      }
      if (messages.length > 0) {
        const batch = this.handleBatch(messages).finally(() => this.batches.delete(batch));
        this.batches.add(batch);
      }
    }
  }

  /** Grupos diferentes em paralelo; dentro do grupo, em sequência. Com shutdown, não começa as que faltam. */
  private async handleBatch(messages: readonly Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      this.unsettled.set(keyOf(message), message);
      const group = groups.get(groupIdOf(message));
      if (group === undefined) {
        groups.set(groupIdOf(message), [message]);
      } else {
        group.push(message);
      }
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          if (this.stopping) {
            return;
          }
          await this.handle(message);
        }
      }),
    );
  }

  /** Uma mensagem, num contexto de log próprio (até o envelope ser lido, o id é o `MessageId` do SQS). */
  private handle(message: Message): Promise<void> {
    const sqsMessageId = message.MessageId ?? 'unknown';
    const correlationId = resolveCorrelationId(stringAttributeOf(message, 'correlationId') ?? sqsMessageId);
    return runWithCorrelation({ correlationId, messageId: sqsMessageId }, () => this.handleInContext(message));
  }

  private async handleInContext(message: Message): Promise<void> {
    const key = keyOf(message);
    const startedAt = performance.now();
    let envelopeMessageId: string | undefined;
    try {
      const envelope = parseWagerEnvelope(message.Body);
      envelopeMessageId = envelope.messageId;
      const correlationId = resolveCorrelationId(stringAttributeOf(message, 'correlationId') ?? envelope.messageId);
      addLogContext({ correlationId, messageId: envelope.messageId, causationId: envelope.messageId });
      const result = await this.processWagerTransaction.execute(envelope.command, {
        source: 'sqs',
        correlationId,
        causationId: envelope.messageId,
        inbox: {
          consumerName: WAGER_CONSUMER_NAME,
          messageId: envelope.messageId,
          payloadHash: envelope.payloadHash,
        },
      });
      if (this.settings.exitAfterCommit) {
        // Fault hook (só testes): commit feito, ack nunca enviado — a mensagem volta e cai na inbox.
        process.exit(CONSUMER_FAULT_EXIT_CODE);
      }
      if (result.inboxDuplicate) {
        this.metrics.inboxDuplicates.inc();
      }
      await this.ack(message);
      this.logProcessed(result, performance.now() - startedAt);
    } catch (error: unknown) {
      if (error instanceof InvalidEnvelopeError && error.envelopeMessageId !== undefined) {
        envelopeMessageId = error.envelopeMessageId;
        addLogContext({ messageId: envelopeMessageId });
      }
      await this.handleFailure(message, error, envelopeMessageId ?? message.MessageId ?? 'unknown', startedAt);
    } finally {
      this.unsettled.delete(key);
      this.wakeLoop?.();
    }
  }

  private async handleFailure(
    message: Message,
    error: unknown,
    originalMessageId: string,
    startedAt: number,
  ): Promise<void> {
    const { class: errorClass, reason } = classify(error);
    const context = {
      messageId: originalMessageId,
      sqsMessageId: message.MessageId,
      reason,
      receiveCount: receiveCountOf(message),
      durationMs: Math.round(performance.now() - startedAt),
    };
    switch (errorClass) {
      case 'business-done':
        this.logger.log(context, 'Message finished with a business outcome');
        await this.ack(message);
        return;
      case 'permanent':
        if (this.released) {
          return;
        }
        try {
          await this.queue.sendToDlq(message, reason, originalMessageId);
          this.metrics.sqsDlqMessages.inc({ reason });
          this.logger.warn({ ...context, err: error }, 'Message sent to the DLQ after a permanent failure');
          await this.ack(message);
        } catch (dlqError: unknown) {
          this.logger.error({ ...context, err: dlqError }, 'Could not move message to the DLQ; retrying later');
          await this.retryLater(message, context);
        }
        return;
      case 'transient':
        this.logger.warn({ ...context, err: error }, 'Transient failure; message will be retried');
        await this.retryLater(message, context);
        return;
    }
  }

  private async retryLater(message: Message, context: Record<string, unknown>): Promise<void> {
    if (this.released) {
      return;
    }
    const receiveCount = receiveCountOf(message);
    const seconds = retryVisibilitySeconds(receiveCount, this.settings.retryBackoff);
    try {
      await this.queue.changeVisibility(message, seconds);
      this.metrics.sqsRetries.inc();
    } catch (error: unknown) {
      // O visibility timeout padrão da fila devolve a mensagem de qualquer jeito.
      this.logger.warn({ ...context, err: error, receiveCount }, 'Could not change message visibility');
    }
  }

  private async ack(message: Message): Promise<void> {
    if (this.released) {
      return;
    }
    try {
      await this.queue.delete(message);
    } catch (error: unknown) {
      // Sem ack a mensagem volta e a inbox garante que não haja segundo efeito.
      this.logger.warn({ err: error, sqsMessageId: message.MessageId }, 'Could not acknowledge message');
    }
  }

  /** Os ids da transação já estão no contexto (o use case os acrescenta); aqui só o desfecho da mensagem. */
  private logProcessed(result: ProcessResult, durationMs: number): void {
    this.logger.log(
      {
        status: result.transaction.status,
        failureCode: result.transaction.failureCode,
        idempotentReplay: result.idempotentReplay,
        inboxDuplicate: result.inboxDuplicate,
        durationMs: Math.round(durationMs),
      },
      'Message processed',
    );
  }
}

function keyOf(message: Message): string {
  return message.ReceiptHandle ?? message.MessageId ?? 'unknown';
}
