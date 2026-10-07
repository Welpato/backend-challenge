import { describe, expect, it } from 'bun:test';
import { Money } from '@/shared/money/money';
import { CurrencyMismatchError } from '@/shared/money/money.errors';
import { LedgerDirection } from '@/wallet/domain/ledger-direction';
import { Wallet, type WalletState } from '@/wallet/domain/wallet';
import { InsufficientFundsError, InvalidWalletOperationError } from '@/wallet/domain/wallet.errors';
import type { WalletLedgerEntry } from '@/wallet/domain/wallet-ledger-entry';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
const T0 = new Date('2026-10-07T12:00:00.000Z');
const T1 = new Date('2026-10-07T12:00:05.000Z');

function openWith(amount: string): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(amount),
    openingTransactionId: 'tx-open',
    at: T0,
  }).wallet;
}

describe('Wallet.open', () => {
  it('opens with zero balance, version 1 and no ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('0.00'),
      at: T0,
    });
    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt.toISOString()).toBe(T0.toISOString());
    expect(wallet.updatedAt.toISOString()).toBe(T0.toISOString());
    expect(openingEntry).toBeUndefined();
  });

  it('ignores openingTransactionId when the initial balance is zero', () => {
    const { openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('0.00'),
      openingTransactionId: 'tx-open',
      at: T0,
    });
    expect(openingEntry).toBeUndefined();
  });

  it('opens with 1000.00 as a CREDIT 0 → 1000.00 entry at walletVersion 1', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('1000.00'),
      openingTransactionId: 'tx-open',
      at: T0,
    });
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeDefined();
    const entry = openingEntry as WalletLedgerEntry;
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-open');
    expect(entry.balanceBefore.toString()).toBe('0.00');
    expect(entry.money.toString()).toBe('1000.00');
    expect(entry.balanceAfter.toString()).toBe('1000.00');
    expect(entry.walletVersion).toBe(1);
    expect(entry.createdAt.toISOString()).toBe(T0.toISOString());
    expect(entry.isBalanced()).toBe(true);
  });

  it('requires an opening transaction for a positive initial balance', () => {
    expect(() => Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('10.00'), at: T0 })).toThrow(
      InvalidWalletOperationError,
    );
  });

  it('rejects a negative initial balance, missing ids and invalid date', () => {
    const base = { id: 'wallet-1', playerId: 'player-1', initialBalance: brl('0.00'), at: T0 };
    expect(() => Wallet.open({ ...base, initialBalance: brl('1.00').negate() })).toThrow(InvalidWalletOperationError);
    expect(() => Wallet.open({ ...base, id: '' })).toThrow(InvalidWalletOperationError);
    expect(() => Wallet.open({ ...base, playerId: '' })).toThrow(InvalidWalletOperationError);
    expect(() => Wallet.open({ ...base, at: new Date('nope') })).toThrow(InvalidWalletOperationError);
  });
});

describe('Wallet.debit', () => {
  it('debits, increments version and returns a balanced entry', () => {
    const wallet = openWith('1000.00');
    const entry = wallet.debit('tx-bet', brl('25.00'), T1);
    expect(wallet.balance.toString()).toBe('975.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe(T1.toISOString());
    expect(wallet.createdAt.toISOString()).toBe(T0.toISOString());
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.transactionId).toBe('tx-bet');
    expect(entry.balanceBefore.toString()).toBe('1000.00');
    expect(entry.balanceAfter.toString()).toBe('975.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  it('allows debiting the exact balance down to zero', () => {
    const wallet = openWith('25.00');
    const entry = wallet.debit('tx-bet', brl('25.00'), T1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(entry.balanceAfter.toString()).toBe('0.00');
  });

  it('throws InsufficientFundsError above the balance and leaves state untouched', () => {
    const wallet = openWith('25.00');
    expect(() => wallet.debit('tx-bet', brl('25.01'), T1)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('25.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt.toISOString()).toBe(T0.toISOString());
  });

  it('exposes the INSUFFICIENT_FUNDS failure code', () => {
    const wallet = openWith('0.00');
    try {
      wallet.debit('tx-bet', brl('0.01'), T1);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientFundsError);
      expect((error as InsufficientFundsError).code).toBe('INSUFFICIENT_FUNDS');
    }
  });
});

describe('Wallet.credit', () => {
  it('credits, increments version and returns a balanced entry', () => {
    const wallet = openWith('0.00');
    const entry = wallet.credit('tx-win', brl('50.00'), T1);
    expect(wallet.balance.toString()).toBe('50.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe(T1.toISOString());
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('0.00');
    expect(entry.balanceAfter.toString()).toBe('50.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });
});

describe('Wallet operation guards', () => {
  it.each(['debit', 'credit'] as const)('%s with another currency throws and leaves state untouched', (op) => {
    const wallet = openWith('100.00');
    expect(() => wallet[op]('tx-1', usd('10.00'), T1)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt.toISOString()).toBe(T0.toISOString());
  });

  it.each(['debit', 'credit'] as const)('%s requires a positive amount', (op) => {
    const wallet = openWith('100.00');
    expect(() => wallet[op]('tx-1', brl('0.00'), T1)).toThrow(InvalidWalletOperationError);
    expect(() => wallet[op]('tx-1', brl('10.00').negate(), T1)).toThrow(InvalidWalletOperationError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it.each(['debit', 'credit'] as const)('%s requires a transactionId and a valid date', (op) => {
    const wallet = openWith('100.00');
    expect(() => wallet[op]('', brl('1.00'), T1)).toThrow(InvalidWalletOperationError);
    expect(() => wallet[op]('tx-1', brl('1.00'), new Date('nope'))).toThrow(InvalidWalletOperationError);
    expect(wallet.version).toBe(1);
  });

  it('exposes no public setters for balance, version or updatedAt', () => {
    for (const name of ['balance', 'version', 'updatedAt', 'createdAt']) {
      const descriptor = Object.getOwnPropertyDescriptor(Wallet.prototype, name);
      expect(descriptor?.get).toBeDefined();
      expect(descriptor?.set).toBeUndefined();
    }
  });

  it('does not leak its dates to callers', () => {
    const wallet = openWith('100.00');
    wallet.updatedAt.setUTCFullYear(2000);
    wallet.createdAt.setUTCFullYear(2000);
    expect(wallet.updatedAt.toISOString()).toBe(T0.toISOString());
    expect(wallet.createdAt.toISOString()).toBe(T0.toISOString());
  });
});

/** PRNG determinístico (mulberry32) — sequência reproduzível em todo run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Valor positivo aleatório entre 0.01 e 500.99, montado como string (sem aritmética em ponto flutuante). */
function randomAmount(random: () => number): Money {
  const units = Math.floor(random() * 501);
  const cents = Math.floor(random() * 100);
  const amount = `${units}.${String(cents).padStart(2, '0')}`;
  return amount === '0.00' ? brl('0.01') : brl(amount);
}

describe('Wallet random sequence', () => {
  it('keeps balance == Σ ledger and contiguous versions after 100 random operations', () => {
    const random = seededRandom(20261007);
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('1000.00'),
      openingTransactionId: 'tx-open',
      at: T0,
    });
    const entries: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];
    let rejected = 0;

    for (let i = 0; i < 100; i++) {
      const money = randomAmount(random);
      const at = new Date(T0.getTime() + (i + 1) * 1000);
      const before = { balance: wallet.balance, version: wallet.version };
      if (random() < 0.55) {
        try {
          entries.push(wallet.debit(`tx-${i}`, money, at));
        } catch (error) {
          expect(error).toBeInstanceOf(InsufficientFundsError);
          expect(wallet.balance.equals(before.balance)).toBe(true);
          expect(wallet.version).toBe(before.version);
          rejected++;
        }
      } else {
        entries.push(wallet.credit(`tx-${i}`, money, at));
      }
      expect(wallet.balance.isNegative()).toBe(false);
    }

    const sum = entries.reduce(
      (total, entry) =>
        entry.direction === LedgerDirection.Credit ? total.add(entry.money) : total.subtract(entry.money),
      Money.zero('BRL'),
    );
    expect(sum.equals(wallet.balance)).toBe(true);
    expect(entries.map((entry) => entry.walletVersion)).toEqual(entries.map((_, index) => index + 1));
    expect(wallet.version).toBe(entries.length);
    expect(entries.length + rejected).toBe(101);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as WalletLedgerEntry;
      expect(entry.isBalanced()).toBe(true);
      if (i > 0) {
        expect(entry.balanceBefore.equals((entries[i - 1] as WalletLedgerEntry).balanceAfter)).toBe(true);
      }
    }
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
  });
});

describe('Wallet.rehydrate', () => {
  it('rebuilds odd persisted state without throwing', () => {
    const state: WalletState = {
      id: 'wallet-9',
      playerId: 'player-9',
      balance: brl('12.34'),
      version: 57,
      createdAt: T0,
      updatedAt: T1,
    };
    const wallet = Wallet.rehydrate(state);
    expect(wallet.id).toBe('wallet-9');
    expect(wallet.playerId).toBe('player-9');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toString()).toBe('12.34');
    expect(wallet.version).toBe(57);
    expect(wallet.updatedAt.toISOString()).toBe(T1.toISOString());

    const entry = wallet.credit('tx-58', brl('1.00'), T1);
    expect(entry.walletVersion).toBe(58);
    expect(entry.balanceBefore.toString()).toBe('12.34');
  });

  it('does not revalidate rules (e.g. a negative persisted balance)', () => {
    expect(() =>
      Wallet.rehydrate({
        id: 'w',
        playerId: 'p',
        balance: brl('5.00').negate(),
        version: 3,
        createdAt: T0,
        updatedAt: T0,
      }),
    ).not.toThrow();
  });
});
