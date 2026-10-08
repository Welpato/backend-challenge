import { Logger } from '@nestjs/common';
import { DomainError } from '@/shared/errors/domain-error';
import { FailureCode } from '@/shared/failure-code';
import type { AppMetrics, WalletLockConflictType } from '@/shared/observability/app-metrics';
import { addLogContext } from '@/shared/observability/correlation';
import { WalletVersionConflictError } from '@/shared/persistence/persistence.errors';
import { classifyPgError, TransientDatabaseError } from '@/shared/persistence/pg-errors';
import type { ProcessingSource, ProcessResult } from '@/wagering/application/process-wager-transaction';
import type { ProcessingTelemetry } from '@/wagering/application/processing-telemetry.port';
import type { ResolveOutcome } from '@/wagering/application/resolve-pending-reference';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';

/** Desfechos do reprocessador que finalizam a transação (contam em `wager_transactions_total`). */
const FINAL_OUTCOMES: ReadonlySet<ResolveOutcome> = new Set(['processed', 'rejected', 'expired', 'failed']);

/** Conflito de lock da wallet a partir do erro (direto ou na cadeia `cause`); `undefined` se não for. */
export function lockConflictTypeOf(error: unknown): WalletLockConflictType | undefined {
  if (error instanceof WalletVersionConflictError) {
    return 'version';
  }
  const classified = classifyPgError(error);
  if (classified instanceof TransientDatabaseError) {
    if (classified.reason === 'lock_timeout') {
      return 'timeout';
    }
    if (classified.reason === 'deadlock') {
      return 'deadlock';
    }
  }
  return undefined;
}

/** Código curto do erro para log/label — nunca a mensagem com dados. */
export function failureCodeOf(error: unknown): string {
  if (error instanceof DomainError) {
    return error.code;
  }
  if (classifyPgError(error) instanceof TransientDatabaseError) {
    return FailureCode.TRANSIENT_UNAVAILABLE;
  }
  return 'INTERNAL_ERROR';
}

function seconds(durationMs: number): number {
  return durationMs / 1000;
}

/**
 * `ProcessingTelemetry` → métricas do catálogo (`AppMetrics`) + uma linha de log estruturada por desfecho, com os
 * identificadores do fluxo (também gravados no contexto ALS, para os demais logs do mesmo fluxo) e `durationMs`.
 * Nada de valor, saldo ou payload.
 */
export class PrometheusProcessingTelemetry implements ProcessingTelemetry {
  private readonly logger = new Logger('WagerProcessing');

  constructor(private readonly metrics: AppMetrics) {}

  walletLockAcquired(waitMs: number): void {
    this.metrics.walletLockWait.observe(seconds(waitMs));
  }

  attemptFailed(error: unknown): void {
    const type = lockConflictTypeOf(error);
    if (type !== undefined) {
      this.metrics.walletLockConflicts.inc({ type });
    }
  }

  processed(result: ProcessResult, source: ProcessingSource, durationMs: number): void {
    const tx = result.transaction;
    const fields = identifiersOf(tx);
    addLogContext(fields);
    if (!result.idempotentReplay) {
      this.metrics.wagerTransactions.inc({
        kind: tx.kind,
        status: tx.status,
        failure_code: tx.failureCode ?? '',
        source,
      });
    } else if (!result.inboxDuplicate) {
      this.metrics.idempotentReplays.inc({ source });
    }
    this.metrics.processingDuration.observe({ source, kind: tx.kind }, seconds(durationMs));
    this.logger.log(
      {
        ...fields,
        source,
        idempotentReplay: result.idempotentReplay,
        inboxDuplicate: result.inboxDuplicate,
        durationMs: Math.round(durationMs),
      },
      'Wager transaction processed',
    );
  }

  processingFailed(error: unknown, kind: string, source: ProcessingSource, durationMs: number): void {
    const failureCode = failureCodeOf(error);
    addLogContext({ kind, failureCode });
    this.metrics.processingDuration.observe({ source, kind }, seconds(durationMs));
    const fields = { kind, failureCode, source, durationMs: Math.round(durationMs) };
    if (error instanceof DomainError) {
      // Conflito, wallet inexistente, contrato: desfecho esperado, sem stack.
      this.logger.warn(fields, 'Wager transaction not processed');
    } else {
      this.logger.warn({ ...fields, err: error }, 'Wager transaction failed');
    }
  }

  pendingResolved(
    transactionId: string,
    outcome: ResolveOutcome,
    tx: WagerTransaction | undefined,
    durationMs: number,
  ): void {
    const fields = tx === undefined ? { transactionId } : identifiersOf(tx);
    addLogContext(tx?.correlationId === undefined ? fields : { ...fields, correlationId: tx.correlationId });
    if (tx !== undefined && FINAL_OUTCOMES.has(outcome)) {
      this.metrics.wagerTransactions.inc({
        kind: tx.kind,
        status: tx.status,
        failure_code: tx.failureCode ?? '',
        source: 'reprocessor',
      });
    }
    if (tx !== undefined) {
      this.metrics.processingDuration.observe({ source: 'reprocessor', kind: tx.kind }, seconds(durationMs));
    }
    const line = { ...fields, source: 'reprocessor', outcome, durationMs: Math.round(durationMs) };
    if (FINAL_OUTCOMES.has(outcome)) {
      this.logger.log(line, 'Pending reference resolved');
    } else {
      this.logger.debug(line, 'Pending reference not resolved yet');
    }
  }
}

function identifiersOf(tx: WagerTransaction) {
  return {
    transactionId: tx.id,
    walletId: tx.walletId,
    providerId: tx.providerId,
    kind: tx.kind,
    status: tx.status,
    failureCode: tx.failureCode,
  };
}
