import type { OutboxRepository } from '@/messaging/outbox/application/outbox.repository.port';
import { OutboxMessage } from '@/messaging/outbox/outbox-message';
import type { Clock } from '@/shared/clock';
import type { EventContext } from '@/shared/events/event-context';
import { newUuidV7 } from '@/shared/ids';
import type { Money } from '@/shared/money/money';
import { ConcurrencyInvariantError } from '@/shared/persistence/persistence.errors';
import { isUniqueViolation } from '@/shared/persistence/pg-errors';
import type { UnitOfWork } from '@/shared/persistence/unit-of-work';
import type { WagerTransactionRepository } from '@/wagering/application/wager-transaction.repository.port';
import { WagerTransactionProcessed } from '@/wagering/domain/events/wager-transaction-processed';
import { WagerTransaction } from '@/wagering/domain/wager-transaction';
import type { LedgerRepository } from '@/wallet/application/ledger.repository.port';
import type { WalletRepository } from '@/wallet/application/wallet.repository.port';
import { WalletBalanceChanged } from '@/wallet/domain/events/wallet-balance-changed';
import { Wallet } from '@/wallet/domain/wallet';
import { WalletAlreadyExistsError } from '@/wallet/domain/wallet.errors';

export interface CreateWalletCommand {
  readonly playerId: string;
  /** Saldo inicial; `0.00` (na moeda da wallet) quando o corpo não traz `initialBalance`. */
  readonly initialBalance: Money;
  readonly correlationId: string;
}

/** Constraint de `(player_id, currency)` (migration 0001_init). */
const WALLET_PLAYER_CURRENCY_CONSTRAINT = 'uq_wallets_player_currency';

/**
 * `CreateWallet` (ESPECIFICACAO.md §5). Numa única transação SQL:
 * 1. INSERT da wallet (`version = 1`);
 * 2. se o saldo inicial for positivo: transação interna `OPENING` (provider `internal`, key `opening:{walletId}`,
 *    já `PROCESSED`), lançamento CREDIT `0 → saldo inicial` e, na outbox, `WagerTransactionProcessed` +
 *    `WalletBalanceChanged`. Com saldo zero não há OPENING, lançamento nem evento.
 *
 * A consistência wallet ↔ ledger é conferida pela constraint trigger diferida no COMMIT. `(player_id, currency)`
 * duplicado → `WalletAlreadyExistsError` (409); nada é persistido.
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const { playerId, initialBalance, correlationId } = command;
    const at = this.clock.now();
    const walletId = newUuidV7();
    const opening = initialBalance.isPositive()
      ? WagerTransaction.createOpening({ walletId, playerId, money: initialBalance, correlationId, at })
      : undefined;
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance,
      ...(opening === undefined ? {} : { openingTransactionId: opening.id }),
      at,
    });

    try {
      await this.uow.run(async () => {
        await this.wallets.insert(wallet);
        if (opening === undefined || openingEntry === undefined) {
          return;
        }
        const insertion = await this.transactions.insertIfAbsent(opening);
        if (!insertion.inserted) {
          // A key `opening:{walletId}` usa um UUID recém-gerado: um conflito aqui é bug, não regra de negócio.
          throw new ConcurrencyInvariantError(`Opening transaction of wallet ${walletId} already exists`);
        }
        await this.ledger.append(openingEntry);
        const ctx: EventContext = { correlationId, occurredAt: at, eventIdFactory: newUuidV7 };
        await this.outbox.enqueue([
          OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx), at),
          OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx), at),
        ]);
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error, WALLET_PLAYER_CURRENCY_CONSTRAINT)) {
        throw new WalletAlreadyExistsError({ cause: error });
      }
      throw error;
    }
    return wallet;
  }
}
