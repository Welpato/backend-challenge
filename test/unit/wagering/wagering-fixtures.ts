import { Money } from '@/shared/money/money';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import { WagerTransaction } from '@/wagering/domain/wager-transaction';
import type { CreateWagerTransactionProps, WagerTransactionState } from '@/wagering/domain/wager-transaction.state';

export const AT = new Date('2026-10-07T12:00:00.000Z');
export const LATER = new Date('2026-10-07T12:00:05.000Z');

export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

/** Props válidas para `create`; REFUND/ROLLBACK ganham referência por padrão. */
export function createProps(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  const needsReference = kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${kind.toLowerCase()}`,
    idempotencyKey: `key-${kind.toLowerCase()}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('25.00'),
    ...(needsReference ? { referenceExternalTransactionId: 'ext-bet' } : {}),
    at: AT,
    ...overrides,
  };
}

/**
 * Transação reidratada em qualquer status/kind — o caminho que o repositório usará. Por padrão é
 * BET `PROCESSED` com external id `ext-bet`, para servir de referência.
 */
export function stored(overrides: Partial<WagerTransactionState> = {}): WagerTransaction {
  const status = overrides.status ?? WagerTransactionStatus.Processed;
  return WagerTransaction.rehydrate({
    id: 'tx-bet',
    providerId: 'provider-a',
    externalTransactionId: 'ext-bet',
    idempotencyKey: 'key-bet',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: AT,
    status,
    attempts: 0,
    ...(status === WagerTransactionStatus.PendingReference ? { nextAttemptAt: LATER } : {}),
    ...overrides,
  });
}
