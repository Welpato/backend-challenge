import { type BeforeApplicationShutdown, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { OutboxRepository } from '@/messaging/outbox/application/outbox.repository.port';
import type { EventPublisher } from '@/messaging/outbox/event-publisher.port';
import type { Clock } from '@/shared/clock';
import { type AppMetrics, OUTBOX_RETRY_ALERT_ATTEMPTS } from '@/shared/observability/app-metrics';
import type { UnitOfWork } from '@/shared/persistence/unit-of-work';
import { type IterationResult, PollingLoop } from '@/shared/workers/polling-loop';

export { OUTBOX_RETRY_ALERT_ATTEMPTS };

export interface OutboxPublisherSettings {
  /** Espera com a outbox vazia (o loop é imediato quando o lote vem cheio). */
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  /** Só testes: `process.exit` depois de publicar e antes do commit (`FAULT_EXIT_AFTER_PUBLISH`). */
  readonly exitAfterPublish: boolean;
}

export interface PublishSummary {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

/** Código de saída do fault hook — distingue a morte simulada de um crash real nos testes. */
export const FAULT_EXIT_CODE = 86;

/**
 * Publisher da outbox transacional (ESPECIFICACAO.md §8, papel `outbox`). Por iteração, numa `UnitOfWork`:
 * `claimDue(batchSize)` (`FOR UPDATE SKIP LOCKED`: publishers concorrentes pegam conjuntos disjuntos) → publica
 * no SQS → `markPublished` nos sucessos / `scheduleRetry` (backoff exponencial, teto 5 min) nas falhas → commit.
 *
 * Garantias: nada é publicado antes do commit da transação de negócio (a linha só fica visível depois dele);
 * nada é perdido — se o processo morre depois de publicar e antes do commit, os locks caem e outra instância
 * publica de novo (duplicata com o mesmo `eventId`, segura para o consumidor); falha nunca descarta.
 * No shutdown termina o lote atual e para.
 *
 * Métricas (`AppMetrics`): `outbox_published_total` e `outbox_publish_failures_total` por iteração; os gauges
 * `outbox_pending`, `outbox_lag_seconds` e `outbox_messages_over_retry_threshold` (pendentes com mais de 10
 * tentativas — alerta) vêm de `collectGauges()`, chamado pela coleta periódica do `OutboxModule` (não no scrape).
 */
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('OutboxPublisherWorker');
  private readonly loop: PollingLoop;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly settings: OutboxPublisherSettings,
    private readonly metrics: AppMetrics,
  ) {
    this.loop = new PollingLoop(() => this.iterate(), {
      intervalMs: settings.pollIntervalMs,
      onError: (error) => this.logger.warn({ err: error }, 'Outbox publication iteration failed'),
    });
  }

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /** Para o loop (testes que dirigem o worker com `runOnce`). */
  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** Uma iteração: reivindica, publica e grava o resultado numa única transação. */
  async runOnce(): Promise<PublishSummary> {
    const startedAt = performance.now();
    const summary = await this.uow.run(async () => {
      const messages = await this.outbox.claimDue(this.settings.batchSize);
      if (messages.length === 0) {
        return { claimed: 0, published: 0, failed: 0 };
      }
      const results = await this.publisher.publishBatch(messages);
      if (this.settings.exitAfterPublish) {
        // Fault hook (só testes): morre com o lote publicado e a transação aberta — os locks caem com a conexão.
        process.exit(FAULT_EXIT_CODE);
      }
      const now = this.clock.now();
      const byId = new Map(results.map((result) => [result.messageId, result]));
      let published = 0;
      for (const message of messages) {
        const result = byId.get(message.id);
        if (result?.ok === true) {
          message.markPublished(now);
          published += 1;
        } else {
          message.scheduleRetry(now, result === undefined ? 'no publish result' : result.error);
          if (message.attempts > OUTBOX_RETRY_ALERT_ATTEMPTS) {
            this.logger.error(
              {
                eventId: message.id,
                eventType: message.eventType,
                walletId: message.aggregateId,
                correlationId: message.correlationId,
                attempts: message.attempts,
              },
              'Outbox message keeps failing to publish',
            );
          }
        }
        await this.outbox.save(message);
      }
      return { claimed: messages.length, published, failed: messages.length - published };
    });
    this.metrics.outboxPublished.inc(summary.published);
    this.metrics.outboxPublishFailures.inc(summary.failed);
    if (summary.claimed > 0) {
      this.logger.log({ ...summary, durationMs: Math.round(performance.now() - startedAt) }, 'Outbox batch processed');
    }
    return summary;
  }

  private async iterate(): Promise<IterationResult> {
    const summary = await this.runOnce();
    if (summary.failed > 0) {
      this.logger.warn({ ...summary }, 'Some outbox messages failed to publish and were rescheduled');
    }
    // Lote cheio e sem falhas → provavelmente há mais; com falhas, espera (o SQS pode estar fora).
    return summary.claimed >= this.settings.batchSize && summary.failed === 0 ? 'busy' : 'idle';
  }

  /** Gauges de banco (coleta periódica, `METRICS_COLLECT_INTERVAL_MS`). */
  async collectGauges(): Promise<void> {
    const { stats, overThreshold } = await this.uow.run(
      async () => ({
        stats: await this.outbox.stats(),
        overThreshold: await this.outbox.countPendingOverAttempts(OUTBOX_RETRY_ALERT_ATTEMPTS),
      }),
      { readOnly: true },
    );
    this.metrics.outboxPending.set(stats.pending);
    this.metrics.outboxLag.set(stats.oldestPendingAgeSeconds);
    this.metrics.outboxOverRetryThreshold.set(overThreshold);
  }
}
