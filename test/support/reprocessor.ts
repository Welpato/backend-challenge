import { type BatchSummary, PendingReferenceWorker } from '@/messaging/reprocessor/pending-reference.worker';
import { appDb } from './db';
import { type RunningTestApp, startTestApp } from './test-app';

export interface RunningReprocessor {
  readonly running: RunningTestApp;
  readonly worker: PendingReferenceWorker;
  close(): Promise<void>;
}

/**
 * Sobe uma instância real com `APP_ROLE=reprocessor` (mesmo `createApp` da produção) e **para o loop** dela,
 * para o teste dirigir o worker com `runOnce()` de forma determinística. `overrides` ajusta TTL, tentativas,
 * backoff e lote.
 */
export async function startReprocessor(overrides: Record<string, string> = {}): Promise<RunningReprocessor> {
  const running = await startTestApp({
    APP_ROLE: 'reprocessor',
    REPROCESSOR_INTERVAL_MS: '60000',
    PENDING_REFERENCE_BACKOFF_BASE_MS: '1',
    ...overrides,
  });
  const worker = running.app.get(PendingReferenceWorker);
  await worker.stop();
  return { running, worker, close: () => running.close() };
}

/** Roda `runOnce` até não haver mais nada vencido; devolve a soma dos resumos. */
export async function drain(worker: PendingReferenceWorker, maxIterations = 50): Promise<BatchSummary> {
  const total: Record<string, number> = {};
  for (let i = 0; i < maxIterations; i += 1) {
    const summary = await worker.runOnce();
    for (const [key, value] of Object.entries(summary)) {
      total[key] = (total[key] ?? 0) + value;
    }
    if (summary.claimed === 0) {
      break;
    }
  }
  return total as BatchSummary;
}

/** Status das transações de provedor de uma wallet (ou de todas), contadas por status. */
export async function statusCounts(): Promise<Record<string, number>> {
  const rows = (await appDb()`
    select status, count(*)::int as n from wager_transactions where kind <> 'OPENING' group by status`) as {
    status: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}
