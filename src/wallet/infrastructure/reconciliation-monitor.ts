import { Logger } from '@nestjs/common';
import { Counter, type Registry } from 'prom-client';
import type { ReconciliationMismatch, ReconciliationMonitor } from '@/wallet/application/reconciliation-monitor.port';

export const RECONCILIATION_MISMATCHES_METRIC = 'reconciliation_mismatches_total';

/**
 * Divergência de reconciliação → log `warn` (wallet, lançamentos conferidos e códigos das verificações; sem
 * valores) + `reconciliation_mismatches_total` no registry do `/metrics`.
 */
export class LoggingReconciliationMonitor implements ReconciliationMonitor {
  private readonly logger = new Logger('ReconcileWallet');
  private readonly mismatches: Counter;

  constructor(registry: Registry) {
    this.mismatches = new Counter({
      name: RECONCILIATION_MISMATCHES_METRIC,
      help: 'Wallet reconciliations that found the stored balance or the ledger chain inconsistent',
      registers: [registry],
    });
  }

  mismatch(mismatch: ReconciliationMismatch): void {
    this.mismatches.inc();
    this.logger.warn(
      { walletId: mismatch.walletId, checkedEntries: mismatch.checkedEntries, issues: mismatch.issues },
      'Wallet reconciliation found a mismatch',
    );
  }
}
