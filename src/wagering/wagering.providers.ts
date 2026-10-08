import type { Provider } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@/config/app-config';
import { INBOX_REPOSITORY, type InboxRepository } from '@/messaging/inbox/application/inbox.repository.port';
import { OUTBOX_REPOSITORY, type OutboxRepository } from '@/messaging/outbox/application/outbox.repository.port';
import { CLOCK, type Clock } from '@/shared/clock';
import { AppMetrics } from '@/shared/observability/app-metrics';
import { UnitOfWork } from '@/shared/persistence/unit-of-work';
import { createKindHandlers, type KindHandler, type SubmittableKind } from '@/wagering/application/kind-handlers';
import { PendingReferencePolicy } from '@/wagering/application/pending-reference-policy';
import { ProcessWagerTransaction } from '@/wagering/application/process-wager-transaction';
import { PROCESSING_TELEMETRY, type ProcessingTelemetry } from '@/wagering/application/processing-telemetry.port';
import { ResolvePendingReference } from '@/wagering/application/resolve-pending-reference';
import { WagerOutcomeWriter } from '@/wagering/application/wager-outcome-writer';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '@/wagering/application/wager-transaction.repository.port';
import { PrometheusProcessingTelemetry } from '@/wagering/infrastructure/prometheus-processing-telemetry';
import { LEDGER_REPOSITORY, type LedgerRepository } from '@/wallet/application/ledger.repository.port';
import { WALLET_REPOSITORY, type WalletRepository } from '@/wallet/application/wallet.repository.port';

const KIND_HANDLERS = Symbol('KIND_HANDLERS');

type KindHandlers = Readonly<Record<SubmittableKind, KindHandler>>;

/**
 * Núcleo do processamento de transações (casos de uso sem decorators do Nest), montado a partir das portas
 * globais do `PersistenceModule` (e do `AppMetrics`: quem usa a lista importa o `MetricsModule`). É uma lista de providers — e não um módulo — para que o papel `api`
 * (`WageringModule`), o reprocessador (F10) e o consumidor SQS (F12) instanciem o mesmo núcleo sem um módulo
 * de feature importar outro.
 */
export const WAGERING_CORE_PROVIDERS: Provider[] = [
  {
    provide: PROCESSING_TELEMETRY,
    useFactory: (metrics: AppMetrics): ProcessingTelemetry => new PrometheusProcessingTelemetry(metrics),
    inject: [AppMetrics],
  },
  {
    provide: KIND_HANDLERS,
    useFactory: (transactions: WagerTransactionRepository): KindHandlers => createKindHandlers(transactions),
    inject: [WAGER_TRANSACTION_REPOSITORY],
  },
  {
    provide: WagerOutcomeWriter,
    useFactory: (
      wallets: WalletRepository,
      ledger: LedgerRepository,
      transactions: WagerTransactionRepository,
      outbox: OutboxRepository,
    ) => new WagerOutcomeWriter(wallets, ledger, transactions, outbox),
    inject: [WALLET_REPOSITORY, LEDGER_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, OUTBOX_REPOSITORY],
  },
  {
    provide: PendingReferencePolicy,
    useFactory: ({ reprocessor }: AppConfig) =>
      new PendingReferencePolicy({
        backoffBaseMs: reprocessor.pendingReferenceBackoffBaseMs,
        backoffMaxMs: reprocessor.pendingReferenceBackoffMaxMs,
        maxAttempts: reprocessor.pendingReferenceMaxAttempts,
        ttlMs: reprocessor.pendingReferenceTtlMs,
      }),
    inject: [APP_CONFIG],
  },
  {
    provide: ProcessWagerTransaction,
    useFactory: (
      uow: UnitOfWork,
      wallets: WalletRepository,
      transactions: WagerTransactionRepository,
      handlers: KindHandlers,
      writer: WagerOutcomeWriter,
      policy: PendingReferencePolicy,
      clock: Clock,
      inbox: InboxRepository,
      telemetry: ProcessingTelemetry,
    ) => new ProcessWagerTransaction(uow, wallets, transactions, handlers, writer, policy, clock, inbox, telemetry),
    inject: [
      UnitOfWork,
      WALLET_REPOSITORY,
      WAGER_TRANSACTION_REPOSITORY,
      KIND_HANDLERS,
      WagerOutcomeWriter,
      PendingReferencePolicy,
      CLOCK,
      INBOX_REPOSITORY,
      PROCESSING_TELEMETRY,
    ],
  },
  {
    provide: ResolvePendingReference,
    useFactory: (
      uow: UnitOfWork,
      wallets: WalletRepository,
      transactions: WagerTransactionRepository,
      handlers: KindHandlers,
      writer: WagerOutcomeWriter,
      policy: PendingReferencePolicy,
      clock: Clock,
      telemetry: ProcessingTelemetry,
    ) => new ResolvePendingReference(uow, wallets, transactions, handlers, writer, policy, clock, telemetry),
    inject: [
      UnitOfWork,
      WALLET_REPOSITORY,
      WAGER_TRANSACTION_REPOSITORY,
      KIND_HANDLERS,
      WagerOutcomeWriter,
      PendingReferencePolicy,
      CLOCK,
      PROCESSING_TELEMETRY,
    ],
  },
];
