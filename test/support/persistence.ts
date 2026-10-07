import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '@/config/load-config';
import { MikroOrmInboxRepository } from '@/messaging/inbox/infrastructure/inbox.repository';
import { MikroOrmOutboxRepository } from '@/messaging/outbox/infrastructure/outbox.repository';
import { PERSISTENCE_RECORDS } from '@/persistence-records';
import { type Clock, SystemClock } from '@/shared/clock';
import { buildMikroOrmConfig } from '@/shared/persistence/mikro-orm.config';
import { UnitOfWork } from '@/shared/persistence/unit-of-work';
import { MikroOrmWagerTransactionRepository } from '@/wagering/infrastructure/wager-transaction.repository';
import { MikroOrmLedgerRepository } from '@/wallet/infrastructure/ledger.repository';
import { MikroOrmWalletRepository } from '@/wallet/infrastructure/wallet.repository';

/**
 * Persistência real para os testes de integração: MikroORM conectado como `app` (DATABASE_URL do
 * .env.test), com os records da aplicação, a `UnitOfWork` e os repositórios. Nada é mockado.
 * O pool é maior que o default para os testes de concorrência abrirem várias transações simultâneas.
 */
export interface Persistence {
  readonly orm: MikroORM;
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly wallets: MikroOrmWalletRepository;
  readonly ledger: MikroOrmLedgerRepository;
  readonly transactions: MikroOrmWagerTransactionRepository;
  readonly inbox: MikroOrmInboxRepository;
  readonly outbox: MikroOrmOutboxRepository;
  close(): Promise<void>;
}

export async function openPersistence(options: { clock?: Clock; poolMax?: number } = {}): Promise<Persistence> {
  const config = loadConfig();
  const orm = await MikroORM.init(
    buildMikroOrmConfig({
      clientUrl: config.database.url,
      entities: [...PERSISTENCE_RECORDS],
      pool: { max: options.poolMax ?? 30 },
    }),
  );
  const clock = options.clock ?? new SystemClock();
  const uow = new UnitOfWork(orm, { lockTimeoutMs: config.database.lockTimeoutMs });
  return {
    orm,
    uow,
    clock,
    wallets: new MikroOrmWalletRepository(uow),
    ledger: new MikroOrmLedgerRepository(uow),
    transactions: new MikroOrmWagerTransactionRepository(uow, clock),
    inbox: new MikroOrmInboxRepository(uow),
    outbox: new MikroOrmOutboxRepository(uow, clock),
    close: () => orm.close(true),
  };
}

/** Promessa resolvida manualmente: coordena transações concorrentes nos testes. */
export interface Latch {
  readonly promise: Promise<void>;
  open(): void;
}

export function latch(): Latch {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Captura o erro de uma operação que deve falhar (falha o teste se ela passar). */
export async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the operation to fail, but it succeeded');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
