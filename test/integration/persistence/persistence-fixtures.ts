import { randomUUID } from 'node:crypto';
import { InboxMessage } from '@/messaging/inbox/inbox-message';
import { OutboxMessage } from '@/messaging/outbox/outbox-message';
import { sha256Hex } from '@/shared/hashing';
import { newUuidV7 } from '@/shared/ids';
import { Money } from '@/shared/money/money';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { WagerTransaction } from '@/wagering/domain/wager-transaction';
import type { CreateWagerTransactionProps } from '@/wagering/domain/wager-transaction.state';
import { WalletBalanceChanged } from '@/wallet/domain/events/wallet-balance-changed';
import { Wallet } from '@/wallet/domain/wallet';
import type { WalletLedgerEntry } from '@/wallet/domain/wallet-ledger-entry';
import type { Persistence } from '../../support/persistence';

/** Instante fixo com milissegundos (o `timestamptz` guarda microssegundos: round-trip exato). */
export const AT = new Date('2026-10-07T12:00:00.123Z');

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export interface OpenedWalletFixture {
  readonly wallet: Wallet;
  readonly opening: WagerTransaction | undefined;
  readonly openingEntry: WalletLedgerEntry | undefined;
}

/**
 * Abre uma wallet como o `CreateWallet` fará (F08): wallet + transação OPENING + crédito de abertura,
 * numa única unidade de trabalho (a consistência wallet ↔ ledger é conferida no commit).
 */
export async function persistOpenedWallet(
  db: Persistence,
  initialBalance: Money = brl('100.00'),
  playerId = `player-${randomUUID()}`,
): Promise<OpenedWalletFixture> {
  const walletId = newUuidV7();
  const opening = initialBalance.isZero()
    ? undefined
    : WagerTransaction.createOpening({ walletId, playerId, money: initialBalance, correlationId: 'corr-open', at: AT });
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId,
    initialBalance,
    ...(opening === undefined ? {} : { openingTransactionId: opening.id }),
    at: AT,
  });
  await db.uow.run(async () => {
    await db.wallets.insert(wallet);
    if (opening !== undefined && openingEntry !== undefined) {
      await db.transactions.insertIfAbsent(opening);
      await db.ledger.append(openingEntry);
    }
  });
  return { wallet, opening, openingEntry };
}

export function betFor(wallet: Wallet, overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${randomUUID()}`;
  return WagerTransaction.create({
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `key-${externalTransactionId}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    correlationId: 'corr-1',
    at: AT,
    ...overrides,
  });
}

export function inboxMessage(messageId = `msg-${randomUUID()}`, payload = 'payload'): InboxMessage {
  return InboxMessage.receive({
    messageId,
    consumerName: 'wager-consumer',
    payloadHash: sha256Hex(payload),
    receivedAt: AT,
  });
}

/** Mensagem de outbox real (envelope de `WalletBalanceChanged`), com `occurredAt`/`now` escolhidos. */
export function outboxMessageFor(
  wallet: Wallet,
  entry: WalletLedgerEntry,
  occurredAt: Date = AT,
  now: Date = occurredAt,
): OutboxMessage {
  const event = WalletBalanceChanged.from(wallet, entry, {
    correlationId: 'corr-1',
    causationId: 'msg-1',
    occurredAt,
    eventIdFactory: newUuidV7,
  });
  return OutboxMessage.enqueue(event, now);
}
