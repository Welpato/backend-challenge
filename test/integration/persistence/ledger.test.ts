import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { Wallet } from '@/wallet/domain/wallet';
import type { WalletLedgerEntry } from '@/wallet/domain/wallet-ledger-entry';
import { MikroOrmLedgerRepository } from '@/wallet/infrastructure/ledger.repository';
import { closeDb, truncateAll } from '../../support/db';
import { openPersistence, type Persistence } from '../../support/persistence';
import { AT, betFor, brl, persistOpenedWallet } from './persistence-fixtures';

let db: Persistence;

beforeAll(async () => {
  db = await openPersistence();
});

afterAll(async () => {
  await db.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

/** Aplica `operations` (débito `-x`, crédito `+x`) em sequência, cada uma na sua unidade de trabalho. */
async function applyOperations(wallet: Wallet, operations: readonly string[]): Promise<void> {
  for (const operation of operations) {
    const money = brl(operation.slice(1));
    const tx = betFor(wallet, { money });
    await db.uow.run(async () => {
      await db.transactions.insertIfAbsent(tx);
      const current = await db.wallets.findByIdForUpdate(wallet.id);
      if (current === undefined) {
        throw new Error('wallet not found');
      }
      const expectedVersion = current.version;
      const entry = operation.startsWith('-') ? current.debit(tx.id, money, AT) : current.credit(tx.id, money, AT);
      await db.wallets.updateBalance(current, expectedVersion);
      await db.ledger.append(entry);
    });
  }
}

const OPERATIONS = ['-10.00', '+0.01', '-20.50', '+99.99', '-0.50', '-30.00', '+1.00'];

describe('LedgerRepository', () => {
  it('pages entries by wallet_version (keyset) in ascending order', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    const { wallet: other } = await persistOpenedWallet(db, brl('5.00'));
    await applyOperations(wallet, OPERATIONS);

    const firstPage = await db.uow.run(() => db.ledger.page(wallet.id, 0, 3));
    const secondPage = await db.uow.run(() => db.ledger.page(wallet.id, 3, 3));
    const lastPage = await db.uow.run(() => db.ledger.page(wallet.id, 6, 3));

    expect(firstPage.map((e) => e.walletVersion)).toEqual([1, 2, 3]);
    expect(secondPage.map((e) => e.walletVersion)).toEqual([4, 5, 6]);
    expect(lastPage.map((e) => e.walletVersion)).toEqual([7, 8]);
    expect(await db.uow.run(() => db.ledger.page(wallet.id, 8, 3))).toEqual([]);
    expect([...firstPage, ...secondPage, ...lastPage].every((e) => e.walletId === wallet.id)).toBe(true);
    expect((await db.uow.run(() => db.ledger.page(other.id, 0, 10))).map((e) => e.walletVersion)).toEqual([1]);
  });

  it('aggregates credits and debits exactly, as NUMERIC strings', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    await applyOperations(wallet, OPERATIONS);
    const totals = await db.uow.run(() => db.ledger.aggregate(wallet.id));
    expect(totals).toEqual({ walletId: wallet.id, credits: '201.00', debits: '61.00', entries: 8 });
    const current = await db.uow.run(() => db.wallets.findById(wallet.id));
    expect(current?.balance.toJSON().amount).toBe('140.00');
  });

  it('aggregates an empty ledger as zero with scale 2', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('0.00'));
    expect(await db.uow.run(() => db.ledger.aggregate(wallet.id))).toEqual({
      walletId: wallet.id,
      credits: '0.00',
      debits: '0.00',
      entries: 0,
    });
  });

  it('streams the whole chain across batches, contiguous and linked', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('100.00'));
    await applyOperations(wallet, OPERATIONS);
    const smallBatches = new MikroOrmLedgerRepository(db.uow, 3);

    const chain = await db.uow.run(async () => {
      const entries: WalletLedgerEntry[] = [];
      for await (const entry of smallBatches.chain(wallet.id)) {
        entries.push(entry);
      }
      return entries;
    });

    expect(chain.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i]?.balanceBefore.equals(chain[i - 1]?.balanceAfter ?? brl('0.00'))).toBe(true);
    }
    expect(chain.every((entry) => entry.isBalanced())).toBe(true);
    expect(chain.at(-1)?.balanceAfter.toJSON().amount).toBe('140.00');
  });

  it('streams nothing for a wallet without entries (exact batch boundary included)', async () => {
    const { wallet } = await persistOpenedWallet(db, brl('0.00'));
    const { wallet: three } = await persistOpenedWallet(db, brl('1.00'));
    await applyOperations(three, ['+1.00', '+1.00']);
    const repo = new MikroOrmLedgerRepository(db.uow, 3);
    const collect = (id: string) =>
      db.uow.run(async () => {
        const versions: number[] = [];
        for await (const entry of repo.chain(id)) {
          versions.push(entry.walletVersion);
        }
        return versions;
      });
    expect(await collect(wallet.id)).toEqual([]);
    expect(await collect(three.id)).toEqual([1, 2, 3]);
  });
});
