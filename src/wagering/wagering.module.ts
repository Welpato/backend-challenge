import { Module } from '@nestjs/common';
import { AuthModule } from '@/auth/auth.module';
import { MetricsModule } from '@/shared/observability/metrics.module';
import { UnitOfWork } from '@/shared/persistence/unit-of-work';
import { GetWagerTransaction } from '@/wagering/application/get-wager-transaction';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '@/wagering/application/wager-transaction.repository.port';
import { WageringController } from '@/wagering/http/wagering.controller';
import { WAGERING_CORE_PROVIDERS } from '@/wagering/wagering.providers';

/** Papel `api`: submissão e consulta de transações por HTTP (F09). */
@Module({
  imports: [AuthModule, MetricsModule],
  controllers: [WageringController],
  providers: [
    ...WAGERING_CORE_PROVIDERS,
    {
      provide: GetWagerTransaction,
      useFactory: (uow: UnitOfWork, transactions: WagerTransactionRepository) =>
        new GetWagerTransaction(uow, transactions),
      inject: [UnitOfWork, WAGER_TRANSACTION_REPOSITORY],
    },
  ],
})
export class WageringModule {}
