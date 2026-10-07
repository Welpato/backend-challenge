import { Money } from '@/shared/money/money';
import type { UnitOfWork } from '@/shared/persistence/unit-of-work';
import type { LedgerRepository } from '@/wallet/application/ledger.repository.port';
import { checkLedgerChain, ReconciliationIssue } from '@/wallet/application/ledger-chain-check';
import type { ReconciliationMonitor } from '@/wallet/application/reconciliation-monitor.port';
import type { WalletRepository } from '@/wallet/application/wallet.repository.port';
import { WalletNotFoundError } from '@/wallet/domain/wallet.errors';

export interface ReconciliationReport {
  readonly walletId: string;
  readonly storedBalance: Money;
  /** Σ créditos − Σ débitos do ledger. */
  readonly calculatedBalance: Money;
  /** `storedBalance − calculatedBalance` (pode ser negativo). */
  readonly difference: Money;
  readonly consistent: boolean;
  readonly checkedEntries: number;
  /** Verificações que falharam (vão para o log; a resposta HTTP segue o formato do enunciado). */
  readonly issues: readonly string[];
}

/**
 * `ReconcileWallet` (ESPECIFICACAO.md §5). Transação `REPEATABLE READ` **somente leitura**: wallet, somas e
 * cadeia vêm do mesmo snapshot, então operações concorrentes não geram falso positivo. Calcula
 * `Σ créditos − Σ débitos` com `Money` (as somas saem do PostgreSQL como `numeric` em texto, nunca `number`),
 * confere a cadeia (`checkLedgerChain`) e compara com o saldo gravado. Divergência → `ReconciliationMonitor`
 * (log `warn` + `reconciliation_mismatches_total`) e `consistent: false`. **Nunca corrige o saldo.**
 */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly monitor: ReconciliationMonitor,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.uow.run(
      async () => {
        const wallet = await this.wallets.findById(walletId);
        if (wallet === undefined) {
          throw new WalletNotFoundError(walletId);
        }
        const totals = await this.ledger.aggregate(walletId);
        const currency = wallet.currency;
        const calculated = Money.from({ amount: totals.credits, currency }).subtract(
          Money.from({ amount: totals.debits, currency }),
        );
        const chain = await checkLedgerChain(wallet, this.ledger.chain(walletId));
        const issues = new Set<string>(chain.issues);
        if (!calculated.equals(wallet.balance)) {
          issues.add(ReconciliationIssue.BalanceMismatch);
        }
        if (chain.checkedEntries !== totals.entries) {
          issues.add(ReconciliationIssue.EntryCountMismatch);
        }
        return {
          walletId,
          storedBalance: wallet.balance,
          calculatedBalance: calculated,
          difference: wallet.balance.subtract(calculated),
          consistent: issues.size === 0,
          checkedEntries: chain.checkedEntries,
          issues: [...issues].sort(),
        } satisfies ReconciliationReport;
      },
      { isolation: 'repeatable read', readOnly: true },
    );
    if (!report.consistent) {
      this.monitor.mismatch({ walletId, checkedEntries: report.checkedEntries, issues: report.issues });
    }
    return report;
  }
}
