import { Global, Module } from '@nestjs/common';
import { INBOX_REPOSITORY } from '@/messaging/inbox/application/inbox.repository.port';
import { MikroOrmInboxRepository } from '@/messaging/inbox/infrastructure/inbox.repository';
import { OUTBOX_REPOSITORY } from '@/messaging/outbox/application/outbox.repository.port';
import { MikroOrmOutboxRepository } from '@/messaging/outbox/infrastructure/outbox.repository';
import { CLOCK, type Clock } from '@/shared/clock';
import { UnitOfWork } from '@/shared/persistence/unit-of-work';
import { WAGER_TRANSACTION_REPOSITORY } from '@/wagering/application/wager-transaction.repository.port';
import { MikroOrmWagerTransactionRepository } from '@/wagering/infrastructure/wager-transaction.repository';
import { LEDGER_REPOSITORY } from '@/wallet/application/ledger.repository.port';
import { WALLET_REPOSITORY } from '@/wallet/application/wallet.repository.port';
import { MikroOrmLedgerRepository } from '@/wallet/infrastructure/ledger.repository';
import { MikroOrmWalletRepository } from '@/wallet/infrastructure/wallet.repository';

/**
 * Liga as portas de persistência às implementações MikroORM (global). Fica na raiz de `src/`, como o
 * `persistence-records.ts`: os módulos de feature (wallet, wagering, mensageria) injetam só os tokens e
 * nunca importam a infraestrutura uns dos outros. Depende do `DatabaseModule` (`UnitOfWork`, `CLOCK`).
 */
@Global()
@Module({
  providers: [
    {
      provide: WALLET_REPOSITORY,
      useFactory: (uow: UnitOfWork) => new MikroOrmWalletRepository(uow),
      inject: [UnitOfWork],
    },
    {
      provide: LEDGER_REPOSITORY,
      useFactory: (uow: UnitOfWork) => new MikroOrmLedgerRepository(uow),
      inject: [UnitOfWork],
    },
    {
      provide: WAGER_TRANSACTION_REPOSITORY,
      useFactory: (uow: UnitOfWork, clock: Clock) => new MikroOrmWagerTransactionRepository(uow, clock),
      inject: [UnitOfWork, CLOCK],
    },
    {
      provide: INBOX_REPOSITORY,
      useFactory: (uow: UnitOfWork) => new MikroOrmInboxRepository(uow),
      inject: [UnitOfWork],
    },
    {
      provide: OUTBOX_REPOSITORY,
      useFactory: (uow: UnitOfWork, clock: Clock) => new MikroOrmOutboxRepository(uow, clock),
      inject: [UnitOfWork, CLOCK],
    },
  ],
  exports: [WALLET_REPOSITORY, LEDGER_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, INBOX_REPOSITORY, OUTBOX_REPOSITORY],
})
export class PersistenceModule {}
