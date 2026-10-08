import { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@/config/app-config';
import { OUTBOX_REPOSITORY, type OutboxRepository } from '@/messaging/outbox/application/outbox.repository.port';
import { EVENT_PUBLISHER, type EventPublisher } from '@/messaging/outbox/event-publisher.port';
import { OutboxPublisherWorker } from '@/messaging/outbox/outbox-publisher.worker';
import { SqsEventPublisher } from '@/messaging/outbox/sqs-event-publisher';
import { SqsQueueUrls } from '@/messaging/sqs/sqs.client';
import { CLOCK, type Clock } from '@/shared/clock';
import { AppMetrics } from '@/shared/observability/app-metrics';
import { MetricsModule } from '@/shared/observability/metrics.module';
import { PeriodicCollector } from '@/shared/observability/periodic-collector';
import { UnitOfWork } from '@/shared/persistence/unit-of-work';

/** Timeout de cada chamada ao SQS feita pelo publisher (os locks da outbox ficam presos enquanto isso). */
const PUBLISH_REQUEST_TIMEOUT_MS = 10_000;

/** Coleta periódica de `outbox_pending`, `outbox_lag_seconds` e do alerta de tentativas (F14). */
export const OUTBOX_GAUGES_COLLECTOR = Symbol('OUTBOX_GAUGES_COLLECTOR');

/** Papel `outbox` (F11): publica os eventos da outbox transacional em `wallet-events.fifo`. */
@Module({
  imports: [MetricsModule],
  providers: [
    {
      provide: EVENT_PUBLISHER,
      useFactory: (client: SQSClient, queueUrls: SqsQueueUrls, config: AppConfig) =>
        new SqsEventPublisher(client, queueUrls, {
          queueName: config.sqs.queues.walletEvents,
          requestTimeoutMs: PUBLISH_REQUEST_TIMEOUT_MS,
        }),
      inject: [SQSClient, SqsQueueUrls, APP_CONFIG],
    },
    {
      provide: OutboxPublisherWorker,
      useFactory: (
        uow: UnitOfWork,
        outbox: OutboxRepository,
        publisher: EventPublisher,
        clock: Clock,
        config: AppConfig,
        metrics: AppMetrics,
      ) =>
        new OutboxPublisherWorker(
          uow,
          outbox,
          publisher,
          clock,
          {
            pollIntervalMs: config.outbox.pollIntervalMs,
            batchSize: config.outbox.batchSize,
            exitAfterPublish: config.faults.exitAfterPublish,
          },
          metrics,
        ),
      inject: [UnitOfWork, OUTBOX_REPOSITORY, EVENT_PUBLISHER, CLOCK, APP_CONFIG, AppMetrics],
    },
    {
      provide: OUTBOX_GAUGES_COLLECTOR,
      useFactory: (worker: OutboxPublisherWorker, config: AppConfig) =>
        new PeriodicCollector('OutboxGauges', config.metrics.collectIntervalMs, () => worker.collectGauges()),
      inject: [OutboxPublisherWorker, APP_CONFIG],
    },
  ],
})
export class OutboxModule {}
