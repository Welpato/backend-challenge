import { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@/config/app-config';
import { SqsQueueUrls } from '@/messaging/sqs/sqs.client';
import { WagerConsumerWorker } from '@/messaging/sqs/wager-consumer.worker';
import { WagerQueue } from '@/messaging/sqs/wager-queue';
import { AppMetrics } from '@/shared/observability/app-metrics';
import { MetricsModule } from '@/shared/observability/metrics.module';
import { ProcessWagerTransaction } from '@/wagering/application/process-wager-transaction';
import { WAGERING_CORE_PROVIDERS } from '@/wagering/wagering.providers';

/** Papel `consumer` (F12): consome `wager-transactions.fifo` com o mesmo use case do HTTP. */
@Module({
  imports: [MetricsModule],
  providers: [
    ...WAGERING_CORE_PROVIDERS,
    {
      provide: WagerQueue,
      useFactory: (client: SQSClient, queueUrls: SqsQueueUrls, config: AppConfig) =>
        new WagerQueue(client, queueUrls, {
          queueName: config.sqs.queues.wagerTransactions,
          dlqName: config.sqs.queues.wagerTransactionsDlq,
          waitTimeSeconds: config.sqs.waitTimeSeconds,
        }),
      inject: [SQSClient, SqsQueueUrls, APP_CONFIG],
    },
    {
      provide: WagerConsumerWorker,
      useFactory: (queue: WagerQueue, process: ProcessWagerTransaction, config: AppConfig, metrics: AppMetrics) =>
        new WagerConsumerWorker(
          queue,
          process,
          {
            shutdownGraceMs: config.timeouts.shutdownGraceMs,
            maxInFlight: config.sqs.consumerMaxInFlight,
            retryBackoff: { baseMs: config.sqs.retryBackoffBaseMs, maxMs: config.sqs.retryBackoffMaxMs },
            exitAfterCommit: config.faults.exitAfterCommit,
          },
          metrics,
        ),
      inject: [WagerQueue, ProcessWagerTransaction, APP_CONFIG, AppMetrics],
    },
  ],
})
export class ConsumerModule {}
