import { describe, expect, it } from 'bun:test';
import { InvalidIntegrationEventError } from '@/shared/events/integration-event.errors';
import { Money } from '@/shared/money/money';
import { WalletBalanceChanged } from '@/wallet/domain/events/wallet-balance-changed';
import { LedgerDirection } from '@/wallet/domain/ledger-direction';
import { Wallet } from '@/wallet/domain/wallet';
import { eventContext, expectFrozenDeep, expectPlainJson } from './event-fixtures';

const T0 = new Date('2026-10-07T12:00:00.000Z');
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

function openWallet(id = 'wallet-1') {
  return Wallet.open({
    id,
    playerId: 'player-1',
    initialBalance: brl('1000.00'),
    openingTransactionId: 'tx-open',
    at: T0,
  });
}

describe('WalletBalanceChanged', () => {
  it('serializes exactly the fields of the statement for a debit', () => {
    const { wallet } = openWallet();
    const entry = wallet.debit('tx-bet', brl('25.00'), T0);
    const event = WalletBalanceChanged.from(wallet, entry, eventContext());
    expect(event.toJSON() as unknown).toStrictEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-10-07T12:00:00.123Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-bet',
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '1000.00', currency: 'BRL' },
        balanceAfter: { amount: '975.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  it('describes the opening credit', () => {
    const { wallet, openingEntry } = openWallet();
    if (openingEntry === undefined) {
      throw new Error('expected an opening entry');
    }
    const { data } = WalletBalanceChanged.from(wallet, openingEntry, eventContext());
    expect(data.direction).toBe(LedgerDirection.Credit);
    expect(data.balanceBefore).toStrictEqual({ amount: '0.00', currency: 'BRL' });
    expect(data.walletVersion).toBe(1);
  });

  it('has eventType/version from the type, plain JSON data and round-trips', () => {
    const { wallet } = openWallet();
    const event = WalletBalanceChanged.from(wallet, wallet.credit('tx-win', brl('50.00'), T0), eventContext());
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expectPlainJson(event.toJSON());
    expect(JSON.parse(JSON.stringify(event))).toStrictEqual(event.toJSON());
  });

  it('has deeply immutable data', () => {
    const { wallet } = openWallet();
    const event = WalletBalanceChanged.from(wallet, wallet.debit('tx-bet', brl('1.00'), T0), eventContext());
    expectFrozenDeep(event.data);
    expect(() => {
      (event.data.balanceAfter as { amount: string }).amount = '1000000.00';
    }).toThrow(TypeError);
    expect(() => {
      (event.data as { walletVersion: number }).walletVersion = 99;
    }).toThrow(TypeError);
  });

  it('refuses an entry from another wallet', () => {
    const { wallet } = openWallet('wallet-1');
    const { wallet: other } = openWallet('wallet-2');
    const entry = other.debit('tx-bet', brl('1.00'), T0);
    expect(() => WalletBalanceChanged.from(wallet, entry, eventContext())).toThrow(InvalidIntegrationEventError);
  });

  it('refuses an entry that is not the latest change of the wallet', () => {
    const { wallet } = openWallet();
    const first = wallet.debit('tx-1', brl('1.00'), T0);
    wallet.debit('tx-2', brl('1.00'), T0);
    expect(() => WalletBalanceChanged.from(wallet, first, eventContext())).toThrow(InvalidIntegrationEventError);
  });
});
