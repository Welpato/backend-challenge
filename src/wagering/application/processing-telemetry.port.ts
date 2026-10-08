import type { ProcessingSource, ProcessResult } from '@/wagering/application/process-wager-transaction';
import type { ResolveOutcome } from '@/wagering/application/resolve-pending-reference';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';

export const PROCESSING_TELEMETRY = Symbol('PROCESSING_TELEMETRY');

/**
 * Observabilidade do processamento de transações (F14), sem tipos de métrica/log na camada de aplicação: o use
 * case e o reprocessador avisam o que aconteceu; a implementação (`PrometheusProcessingTelemetry`) transforma em
 * métricas de §10 e no log estruturado. Chamado **depois** do commit (ou da falha) — nunca dentro da transação.
 */
export interface ProcessingTelemetry {
  /** Tempo entre pedir o lock da wallet e obtê-lo (`wallet_lock_wait_seconds`). */
  walletLockAcquired(waitMs: number): void;
  /** Uma tentativa falhou (inclusive as repetidas internamente): conta conflitos de lock por tipo. */
  attemptFailed(error: unknown): void;
  /** Desfecho de `ProcessWagerTransaction.execute` (HTTP ou SQS). */
  processed(result: ProcessResult, source: ProcessingSource, durationMs: number): void;
  /** `execute` terminou com erro (conflito, wallet inexistente, transitório…). */
  processingFailed(error: unknown, kind: string, source: ProcessingSource, durationMs: number): void;
  /** Uma passada do reprocessador numa transação pendente; `tx` é o estado final (ausente em `skipped`). */
  pendingResolved(
    transactionId: string,
    outcome: ResolveOutcome,
    tx: WagerTransaction | undefined,
    durationMs: number,
  ): void;
}
