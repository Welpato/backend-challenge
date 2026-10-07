import { InboxMessageRecord } from '@/messaging/inbox/infrastructure/inbox-message.record';
import { OutboxMessageRecord } from '@/messaging/outbox/infrastructure/outbox-message.record';
import { WagerTransactionRecord } from '@/wagering/infrastructure/wager-transaction.record';
import { LedgerEntryRecord } from '@/wallet/infrastructure/ledger-entry.record';
import { WalletRecord } from '@/wallet/infrastructure/wallet.record';

/**
 * Wiring: todos os records do MikroORM, registrados pelo `AppModule` no `DatabaseModule`.
 * Fica na raiz de `src/` (como `app.module.ts`) porque junta records de vários módulos — `shared/`
 * não importa módulos de feature.
 */
export const PERSISTENCE_RECORDS = [
  WalletRecord,
  LedgerEntryRecord,
  WagerTransactionRecord,
  InboxMessageRecord,
  OutboxMessageRecord,
] as const;
