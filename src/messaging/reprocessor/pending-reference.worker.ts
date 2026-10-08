import { type BeforeApplicationShutdown, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { AppMetrics } from '@/shared/observability/app-metrics';
import { runWithCorrelation } from '@/shared/observability/correlation';
import { isTransientDatabaseError } from '@/shared/persistence/pg-errors';
import type { UnitOfWork } from '@/shared/persistence/unit-of-work';
import { type IterationResult, PollingLoop } from '@/shared/workers/polling-loop';
import type { ResolveOutcome, ResolvePendingReference } from '@/wagering/application/resolve-pending-reference';
import type { WagerTransactionRepository } from '@/wagering/application/wager-transaction.repository.port';

export interface PendingReferenceWorkerSettings {
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
}

export const PENDING_REFERENCES_METRIC = 'pending_references';

export type BatchSummary = Readonly<Record<ResolveOutcome | 'claimed' | 'errors', number>>;

/**
 * Reprocessador de `PENDING_REFERENCE` (ESPECIFICACAO.md §8, papel `reprocessor`). A cada `intervalMs`:
 * 1. transação curta: `claimDuePendingReferences(batchSize, leaseMs)` (`FOR UPDATE SKIP LOCKED` + lease) —
 *    instâncias concorrentes recebem conjuntos disjuntos e não esperam umas pelas outras;
 * 2. para cada id, `ResolvePendingReference` na **própria** transação (lock da wallet primeiro).
 *
 * Falha transitória num id: fica para quando a lease vencer. Erro inesperado: `recordFailure` (reagenda ou,
 * esgotado, `FAILED`). Lote cheio → próxima iteração sem esperar. No shutdown termina o lote atual e para.
 * Cada id roda num contexto de log próprio (correlationId da transação, quando conhecida). O gauge
 * `pending_references` vem de `collectGauges()`, chamado pela coleta periódica do `ReprocessorModule`.
 */
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('PendingReferenceWorker');
  private readonly loop: PollingLoop;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly transactions: WagerTransactionRepository,
    private readonly resolver: ResolvePendingReference,
    private readonly settings: PendingReferenceWorkerSettings,
    private readonly metrics: AppMetrics,
  ) {
    this.loop = new PollingLoop(() => this.iterate(), {
      intervalMs: settings.intervalMs,
      onError: (error) => this.logger.warn({ err: error }, 'Pending reference iteration failed'),
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

  /** Uma iteração completa: reivindica um lote e resolve cada transação. */
  async runOnce(): Promise<BatchSummary> {
    const ids = await this.uow.run(() =>
      this.transactions.claimDuePendingReferences(this.settings.batchSize, this.settings.leaseMs),
    );
    const summary: Record<ResolveOutcome | 'claimed' | 'errors', number> = {
      claimed: ids.length,
      skipped: 0,
      processed: 0,
      rejected: 0,
      rescheduled: 0,
      expired: 0,
      failed: 0,
      errors: 0,
    };
    for (const id of ids) {
      const outcome = await this.resolveOne(id);
      summary[outcome] += 1;
    }
    return summary;
  }

  private async iterate(): Promise<IterationResult> {
    const summary = await this.runOnce();
    if (summary.claimed > 0) {
      this.logger.log({ ...summary }, 'Pending references processed');
    }
    return summary.claimed >= this.settings.batchSize ? 'busy' : 'idle';
  }

  /** Um id num contexto de log próprio (o `ResolvePendingReference` acrescenta os ids da transação). */
  private resolveOne(id: string): Promise<ResolveOutcome | 'errors'> {
    return runWithCorrelation({ correlationId: id, transactionId: id }, () => this.resolveInContext(id));
  }

  private async resolveInContext(id: string): Promise<ResolveOutcome | 'errors'> {
    try {
      return await this.resolver.execute(id);
    } catch (error: unknown) {
      if (isTransientDatabaseError(error)) {
        this.logger.warn({ transactionId: id, err: error }, 'Transient failure resolving a pending reference');
        return 'errors';
      }
      this.logger.error({ transactionId: id, err: error }, 'Unexpected failure resolving a pending reference');
      try {
        return await this.resolver.recordFailure(id);
      } catch (recordError: unknown) {
        this.logger.error({ transactionId: id, err: recordError }, 'Could not record the failure');
        return 'errors';
      }
    }
  }

  /** Gauge de banco (coleta periódica, `METRICS_COLLECT_INTERVAL_MS`). */
  async collectGauges(): Promise<void> {
    this.metrics.pendingReferences.set(
      await this.uow.run(() => this.transactions.countPendingReferences(), { readOnly: true }),
    );
  }
}
