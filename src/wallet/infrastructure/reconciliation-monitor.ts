import { Logger } from '@nestjs/common';
import type { AppMetrics } from '@/shared/observability/app-metrics';
import type { ReconciliationMismatch, ReconciliationMonitor } from '@/wallet/application/reconciliation-monitor.port';

export const RECONCILIATION_MISMATCHES_METRIC = 'reconciliation_mismatches_total';

/**
 * Divergência de reconciliação → log `warn` (wallet, lançamentos conferidos e códigos das verificações; sem
 * valores) + `reconciliation_mismatches_total` no registry do `/metrics`.
 */
export class LoggingReconciliationMonitor implements ReconciliationMonitor {
  private readonly logger = new Logger('ReconcileWallet');

  constructor(private readonly metrics: AppMetrics) {}

  mismatch(mismatch: ReconciliationMismatch): void {
    this.metrics.reconciliationMismatches.inc();
    this.logger.warn(
      { walletId: mismatch.walletId, checkedEntries: mismatch.checkedEntries, issues: mismatch.issues },
      'Wallet reconciliation found a mismatch',
    );
  }
}
