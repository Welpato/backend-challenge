import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@/config/app-config';
import { AppMetrics } from '@/shared/observability/app-metrics';
import { MetricsModule } from '@/shared/observability/metrics.module';
import { PeriodicCollector } from '@/shared/observability/periodic-collector';
import { UnitOfWork } from '@/shared/persistence/unit-of-work';
import { ResolvePendingReference } from '@/wagering/application/resolve-pending-reference';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '@/wagering/application/wager-transaction.repository.port';
import { WAGERING_CORE_PROVIDERS } from '@/wagering/wagering.providers';
import { PendingReferenceWorker } from './pending-reference.worker';

/** Coleta periódica do gauge `pending_references` (F14). */
export const PENDING_GAUGE_COLLECTOR = Symbol('PENDING_GAUGE_COLLECTOR');

/** Papel `reprocessor` (F10): resolve transações `PENDING_REFERENCE` em background. */
@Module({
  imports: [MetricsModule],
  providers: [
    ...WAGERING_CORE_PROVIDERS,
    {
      provide: PendingReferenceWorker,
      useFactory: (
        uow: UnitOfWork,
        transactions: WagerTransactionRepository,
        resolver: ResolvePendingReference,
        config: AppConfig,
        metrics: AppMetrics,
      ) =>
        new PendingReferenceWorker(
          uow,
          transactions,
          resolver,
          {
            intervalMs: config.reprocessor.intervalMs,
            batchSize: config.reprocessor.batchSize,
            leaseMs: config.reprocessor.leaseMs,
          },
          metrics,
        ),
      inject: [UnitOfWork, WAGER_TRANSACTION_REPOSITORY, ResolvePendingReference, APP_CONFIG, AppMetrics],
    },
    {
      provide: PENDING_GAUGE_COLLECTOR,
      useFactory: (worker: PendingReferenceWorker, config: AppConfig) =>
        new PeriodicCollector('PendingReferenceGauges', config.metrics.collectIntervalMs, () => worker.collectGauges()),
      inject: [PendingReferenceWorker, APP_CONFIG],
    },
  ],
})
export class ReprocessorModule {}
