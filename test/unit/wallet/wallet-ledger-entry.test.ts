import { describe, expect, it } from 'bun:test';
import { Money } from '@/shared/money/money';
import { LedgerDirection } from '@/wallet/domain/ledger-direction';
import { InvalidLedgerEntryError } from '@/wallet/domain/wallet.errors';
import { type CreateLedgerEntryProps, WalletLedgerEntry } from '@/wallet/domain/wallet-ledger-entry';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

function props(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: brl('25.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('75.00'),
    walletVersion: 2,
    createdAt: new Date('2026-10-07T12:00:00.000Z'),
    ...overrides,
  };
}

describe('WalletLedgerEntry.create', () => {
  it('creates a balanced debit entry', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toString()).toBe('75.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  it('creates a balanced credit entry', () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceBefore: brl('0.00'), balanceAfter: brl('25.00') }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  it('allows a debit down to exactly zero', () => {
    const entry = WalletLedgerEntry.create(props({ balanceBefore: brl('25.00'), balanceAfter: brl('0.00') }));
    expect(entry.balanceAfter.isZero()).toBe(true);
  });

  it.each([
    ['debit with wrong after', props({ balanceAfter: brl('76.00') })],
    ['credit treated as debit', props({ direction: LedgerDirection.Credit })],
    ['off by one cent', props({ balanceAfter: brl('75.01') })],
  ])('rejects wrong arithmetic: %s', (_label, input) => {
    expect(() => WalletLedgerEntry.create(input)).toThrow(InvalidLedgerEntryError);
  });

  it('rejects zero money', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ money: brl('0.00'), balanceBefore: brl('1.00'), balanceAfter: brl('1.00') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects negative money', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ money: brl('25.00').negate(), balanceBefore: brl('100.00'), balanceAfter: brl('125.00') }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects a negative balanceAfter even when the arithmetic adds up', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ balanceBefore: brl('10.00'), balanceAfter: brl('15.00').negate() })),
    ).toThrow(InvalidLedgerEntryError);
  });

  it.each([
    ['money', props({ money: usd('25.00') })],
    ['balanceBefore', props({ balanceBefore: usd('100.00') })],
    ['balanceAfter', props({ balanceAfter: usd('75.00') })],
  ])('rejects a different currency in %s', (_label, input) => {
    expect(() => WalletLedgerEntry.create(input)).toThrow(InvalidLedgerEntryError);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects walletVersion %p', (walletVersion) => {
    expect(() => WalletLedgerEntry.create(props({ walletVersion }))).toThrow(InvalidLedgerEntryError);
  });

  it('rejects missing ids, unknown direction and invalid date', () => {
    expect(() => WalletLedgerEntry.create(props({ transactionId: '' }))).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create(props({ walletId: '' }))).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create(props({ direction: 'SIDEWAYS' as LedgerDirection }))).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() => WalletLedgerEntry.create(props({ createdAt: new Date('nope') }))).toThrow(InvalidLedgerEntryError);
  });

  it('carries a non-FailureCode error code (programming error)', () => {
    try {
      WalletLedgerEntry.create(props({ balanceAfter: brl('1.00') }));
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidLedgerEntryError);
      expect((error as InvalidLedgerEntryError).code).toBe('INVALID_LEDGER_ENTRY');
    }
  });
});

describe('WalletLedgerEntry immutability', () => {
  it('is frozen and assignments fail in strict mode', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    const mutable = entry as unknown as { balanceAfter: Money; walletVersion: number };
    expect(() => {
      mutable.balanceAfter = brl('1000.00');
    }).toThrow(TypeError);
    expect(() => {
      mutable.walletVersion = 99;
    }).toThrow(TypeError);
    expect(entry.balanceAfter.toString()).toBe('75.00');
    expect(entry.walletVersion).toBe(2);
  });

  it('does not share the createdAt instance with the caller', () => {
    const createdAt = new Date('2026-10-07T12:00:00.000Z');
    const entry = WalletLedgerEntry.create(props({ createdAt }));
    createdAt.setUTCFullYear(2000);
    expect(entry.createdAt.toISOString()).toBe('2026-10-07T12:00:00.000Z');
  });

  it('has no mutating methods', () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter((name) => name !== 'constructor');
    expect(methods).toEqual(['isBalanced']);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  it('rebuilds persisted state without validating rules', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('1.00'), walletVersion: 57 }));
    expect(entry.walletVersion).toBe(57);
    expect(entry.isBalanced()).toBe(false);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it('reports mixed currencies as unbalanced instead of throwing', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: usd('75.00') }));
    expect(entry.isBalanced()).toBe(false);
  });
});
