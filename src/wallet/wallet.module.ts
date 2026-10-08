import { Module } from '@nestjs/common';
import { AuthModule } from '@/auth/auth.module';
import { OUTBOX_REPOSITORY, type OutboxRepository } from '@/messaging/outbox/application/outbox.repository.port';
import { CLOCK, type Clock } from '@/shared/clock';
import { AppMetrics } from '@/shared/observability/app-metrics';
import { MetricsModule } from '@/shared/observability/metrics.module';
import { UnitOfWork } from '@/shared/persistence/unit-of-work';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '@/wagering/application/wager-transaction.repository.port';
import { CreateWallet } from '@/wallet/application/create-wallet';
import { GetLedger } from '@/wallet/application/get-ledger';
import { GetWallet } from '@/wallet/application/get-wallet';
import { LEDGER_REPOSITORY, type LedgerRepository } from '@/wallet/application/ledger.repository.port';
import { ReconcileWallet } from '@/wallet/application/reconcile-wallet';
import { RECONCILIATION_MONITOR, type ReconciliationMonitor } from '@/wallet/application/reconciliation-monitor.port';
import { WALLET_REPOSITORY, type WalletRepository } from '@/wallet/application/wallet.repository.port';
import { WalletController } from '@/wallet/http/wallet.controller';
import { LoggingReconciliationMonitor } from '@/wallet/infrastructure/reconciliation-monitor';

/**
 * Wallet: criação, consultas e reconciliação. Os casos de uso são classes simples (sem decorators do Nest)
 * montadas aqui; as portas de persistência vêm do `PersistenceModule` (global).
 */
@Module({
  imports: [AuthModule, MetricsModule],
  controllers: [WalletController],
  providers: [
    {
      provide: RECONCILIATION_MONITOR,
      useFactory: (metrics: AppMetrics) => new LoggingReconciliationMonitor(metrics),
      inject: [AppMetrics],
    },
    {
      provide: CreateWallet,
      useFactory: (
        uow: UnitOfWork,
        wallets: WalletRepository,
        transactions: WagerTransactionRepository,
        ledger: LedgerRepository,
        outbox: OutboxRepository,
        clock: Clock,
      ) => new CreateWallet(uow, wallets, transactions, ledger, outbox, clock),
      inject: [
        UnitOfWork,
        WALLET_REPOSITORY,
        WAGER_TRANSACTION_REPOSITORY,
        LEDGER_REPOSITORY,
        OUTBOX_REPOSITORY,
        CLOCK,
      ],
    },
    {
      provide: GetWallet,
      useFactory: (uow: UnitOfWork, wallets: WalletRepository) => new GetWallet(uow, wallets),
      inject: [UnitOfWork, WALLET_REPOSITORY],
    },
    {
      provide: GetLedger,
      useFactory: (uow: UnitOfWork, wallets: WalletRepository, ledger: LedgerRepository) =>
        new GetLedger(uow, wallets, ledger),
      inject: [UnitOfWork, WALLET_REPOSITORY, LEDGER_REPOSITORY],
    },
    {
      provide: ReconcileWallet,
      useFactory: (
        uow: UnitOfWork,
        wallets: WalletRepository,
        ledger: LedgerRepository,
        monitor: ReconciliationMonitor,
      ) => new ReconcileWallet(uow, wallets, ledger, monitor),
      inject: [UnitOfWork, WALLET_REPOSITORY, LEDGER_REPOSITORY, RECONCILIATION_MONITOR],
    },
  ],
})
export class WalletModule {}
