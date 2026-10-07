import { describe, expect, it } from 'bun:test';
import { Money } from '@/shared/money/money';
import { checkLedgerChain, ReconciliationIssue } from '@/wallet/application/ledger-chain-check';
import { LedgerDirection } from '@/wallet/domain/ledger-direction';
import { Wallet } from '@/wallet/domain/wallet';
import { WalletLedgerEntry } from '@/wallet/domain/wallet-ledger-entry';

const AT = new Date('2026-10-07T12:00:00Z');
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

async function* iterate(entries: readonly WalletLedgerEntry[]): AsyncIterable<WalletLedgerEntry> {
  yield* entries;
}

function walletWith(balance: string, version: number): Wallet {
  return Wallet.rehydrate({ id: 'w-1', playerId: 'p-1', balance: brl(balance), version, createdAt: AT, updatedAt: AT });
}

function entry(
  version: number,
  direction: LedgerDirection,
  money: string,
  before: string,
  after: string,
  currency = 'BRL',
): WalletLedgerEntry {
  const m = (amount: string) => Money.from({ amount, currency });
  return WalletLedgerEntry.rehydrate({
    id: `e-${version}`,
    walletId: 'w-1',
    transactionId: `t-${version}`,
    direction,
    money: m(money),
    balanceBefore: m(before),
    balanceAfter: m(after),
    walletVersion: version,
    createdAt: AT,
  });
}

/** Cadeia válida: abertura 100.00, débito 30.00, crédito 5.50 → 75.50 na versão 3. */
function validChain(): WalletLedgerEntry[] {
  return [
    entry(1, LedgerDirection.Credit, '100.00', '0.00', '100.00'),
    entry(2, LedgerDirection.Debit, '30.00', '100.00', '70.00'),
    entry(3, LedgerDirection.Credit, '5.50', '70.00', '75.50'),
  ];
}

describe('checkLedgerChain', () => {
  it('accepts a contiguous, balanced chain ending at the wallet state', async () => {
    const result = await checkLedgerChain(walletWith('75.50', 3), iterate(validChain()));
    expect(result.checkedEntries).toBe(3);
    expect([...result.issues]).toEqual([]);
  });

  it('accepts a wallet with no entries and zero balance', async () => {
    const result = await checkLedgerChain(walletWith('0.00', 1), iterate([]));
    expect(result).toEqual({ checkedEntries: 0, issues: new Set() });
  });

  it('flags a wallet with balance but no entries', async () => {
    const result = await checkLedgerChain(walletWith('10.00', 1), iterate([]));
    expect([...result.issues]).toEqual([ReconciliationIssue.LastEntryMismatch]);
  });

  it('flags a stored balance or version different from the last entry', async () => {
    expect([...(await checkLedgerChain(walletWith('80.00', 3), iterate(validChain()))).issues]).toEqual([
      ReconciliationIssue.LastEntryMismatch,
    ]);
    expect([...(await checkLedgerChain(walletWith('75.50', 4), iterate(validChain()))).issues]).toEqual([
      ReconciliationIssue.LastEntryMismatch,
    ]);
  });

  it('flags version gaps', async () => {
    const [first, , third] = validChain();
    const chain = [first, entry(3, LedgerDirection.Debit, '30.00', '100.00', '70.00'), third].filter(
      (e): e is WalletLedgerEntry => e !== undefined,
    );
    const result = await checkLedgerChain(walletWith('75.50', 3), iterate(chain));
    expect(result.issues.has(ReconciliationIssue.VersionGap)).toBe(true);
  });

  it('flags a broken chain (balanceBefore different from the previous balanceAfter)', async () => {
    const chain = validChain();
    chain[2] = entry(3, LedgerDirection.Credit, '5.50', '71.00', '76.50');
    const result = await checkLedgerChain(walletWith('76.50', 3), iterate(chain));
    expect([...result.issues]).toEqual([ReconciliationIssue.ChainBroken]);
  });

  it('flags a first entry that does not start from zero', async () => {
    const chain = [entry(1, LedgerDirection.Credit, '100.00', '1.00', '101.00')];
    const result = await checkLedgerChain(walletWith('101.00', 1), iterate(chain));
    expect([...result.issues]).toEqual([ReconciliationIssue.ChainBroken]);
  });

  it('flags an unbalanced entry', async () => {
    const chain = validChain();
    chain[1] = entry(2, LedgerDirection.Debit, '30.00', '100.00', '71.00');
    chain[2] = entry(3, LedgerDirection.Credit, '4.50', '71.00', '75.50');
    const result = await checkLedgerChain(walletWith('75.50', 3), iterate(chain));
    expect([...result.issues]).toEqual([ReconciliationIssue.EntryUnbalanced]);
  });

  it('flags entries in another currency', async () => {
    const chain = [entry(1, LedgerDirection.Credit, '100.00', '0.00', '100.00', 'USD')];
    const result = await checkLedgerChain(walletWith('100.00', 1), iterate(chain));
    expect(result.issues.has(ReconciliationIssue.CurrencyMismatch)).toBe(true);
  });
});
