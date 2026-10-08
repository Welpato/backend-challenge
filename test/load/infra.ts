import {
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import type { LoadConfig } from './load-config';

/**
 * Acesso direto do teste de carga ao PostgreSQL (role `app`, só leitura aqui) e ao SQS/LocalStack: envio do
 * cenário 4, profundidade das filas, lag da outbox e as verificações finais. Nada é mockado.
 */
export class LoadInfra {
  private constructor(
    readonly db: SQL,
    readonly sqs: SQSClient,
    readonly wagerQueueUrl: string,
    readonly dlqUrl: string,
    readonly eventsQueueUrl: string,
  ) {}

  static async open(config: LoadConfig): Promise<LoadInfra> {
    const db = new SQL(config.databaseUrl, { max: 8 });
    await db`select 1`;
    const sqs = new SQSClient({
      endpoint: config.sqsEndpoint,
      region: config.awsRegion,
      // Mesmo arranjo da app (sqs.client.ts): a URL da fila não é usada como endpoint.
      useQueueUrlAsEndpoint: false,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
    const url = async (name: string): Promise<string> => {
      const output = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      if (output.QueueUrl === undefined) {
        throw new Error(`queue ${name} not found`);
      }
      return output.QueueUrl;
    };
    return new LoadInfra(
      db,
      sqs,
      await url(config.wagerQueueName),
      await url(config.dlqName),
      await url(config.eventsQueueName),
    );
  }

  async send(body: string, groupId: string, deduplicationId: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.wagerQueueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }

  /** Mensagens visíveis + em voo + atrasadas (aproximado, como o próprio SQS informa). */
  async queueDepth(queueUrl: string = this.wagerQueueUrl): Promise<number> {
    const output = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      }),
    );
    const attributes = output.Attributes ?? {};
    return (
      Number(attributes.ApproximateNumberOfMessages ?? 0) +
      Number(attributes.ApproximateNumberOfMessagesNotVisible ?? 0) +
      Number(attributes.ApproximateNumberOfMessagesDelayed ?? 0)
    );
  }

  /**
   * Estado da outbox: pendentes e idade da mais antiga não publicada — a mesma definição do gauge
   * `outbox_lag_seconds` (F14), lida direto do banco a cada segundo (o gauge só é coletado a cada 5 s).
   */
  async outboxStatus(): Promise<{ pending: number; lagSeconds: number }> {
    const rows = (await this.db`
      select count(*)::int as pending,
             coalesce(extract(epoch from (now() - min(occurred_at))), 0)::float8 as lag
        from outbox_messages
       where published_at is null`) as { pending: number; lag: number }[];
    const row = rows[0];
    return { pending: row?.pending ?? 0, lagSeconds: Math.max(0, row?.lag ?? 0) };
  }

  async close(): Promise<void> {
    this.sqs.destroy();
    await this.db.close();
  }
}

export type EventSinkMode = 'consume' | 'purge' | 'off';

/**
 * Destino downstream da `wallet-events.fifo` durante o teste. Nenhum serviço deste repositório consome os
 * eventos; sem um consumidor a fila só cresce, e os emuladores pagam por isso — no `moto`, cada
 * `SendMessageBatch` numa FIFO com ~4 mil mensagens leva ~1,6 s (16–30 ms com a fila vazia) porque a
 * deduplicação, o `DeleteMessage` e o `ReceiveMessage` percorrem a fila inteira. Isso mediria o emulador, não o
 * publisher da outbox.
 *
 * - `consume` (default): recebe e apaga em lotes de 10, como faria um assinante real. Sem long-poll de propósito
 *   (no `moto`, um `ReceiveMessage` bloqueado reprocessa a fila a cada mensagem nova).
 * - `purge`: `PurgeQueue` a cada segundo — consumidor de capacidade infinita, para emuladores em que nem o
 *   `consume` acompanha (foi o caso do `moto` na hot wallet: um grupo FIFO só, 10 mensagens em voo por vez).
 *   O SQS real e o LocalStack limitam o purge a 1 por 60 s; use só com emulador que não limita.
 * - `off`: não toca na fila.
 *
 * `consumed` é exato no `consume` e aproximado no `purge` (profundidade lida antes de cada purge).
 */
export class EventSink {
  private running = false;
  private loops: Promise<void>[] = [];
  consumed = 0;

  constructor(
    private readonly infra: LoadInfra,
    private readonly mode: EventSinkMode,
  ) {}

  start(): void {
    this.running = true;
    if (this.mode === 'consume') {
      this.loops = [this.consumeLoop(), this.consumeLoop()];
    } else if (this.mode === 'purge') {
      this.loops = [this.purgeLoop()];
    }
  }

  private async consumeLoop(): Promise<void> {
    const { sqs, eventsQueueUrl } = this.infra;
    while (this.running) {
      try {
        const output = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: eventsQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
        );
        const messages = output.Messages ?? [];
        if (messages.length === 0) {
          await Bun.sleep(100);
          continue;
        }
        await sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: eventsQueueUrl,
            Entries: messages.map((message, index) => ({
              Id: String(index),
              ReceiptHandle: message.ReceiptHandle ?? '',
            })),
          }),
        );
        this.consumed += messages.length;
      } catch {
        await Bun.sleep(200);
      }
    }
  }

  private async purgeLoop(): Promise<void> {
    const { sqs, eventsQueueUrl } = this.infra;
    while (this.running) {
      try {
        const depth = await this.infra.queueDepth(eventsQueueUrl);
        if (depth > 0) {
          await sqs.send(new PurgeQueueCommand({ QueueUrl: eventsQueueUrl }));
          this.consumed += depth;
        }
      } catch {
        // PurgeQueueInProgress (SQS real/LocalStack) ou falha transitória: tenta no próximo ciclo.
      }
      await Bun.sleep(1000);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.loops);
  }
}

/** Literal de array do PostgreSQL para ids/keys gerados pelo próprio teste (sem vírgula, aspas ou chaves). */
export function pgArray(values: readonly string[]): string {
  for (const value of values) {
    if (/[,"{}\\\s]/.test(value)) {
      throw new Error(`value not allowed in a pg array literal: ${value}`);
    }
  }
  return `{${values.join(',')}}`;
}
