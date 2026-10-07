import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { appDb, closeDb, expectPgError, PgError, truncateAll } from '../../support/db';
import {
  insertFundedWallet,
  insertLedgerEntry,
  insertTransaction,
  insertWallet,
  ledgerEntryRow,
  processedRow,
  walletRow,
} from './schema-fixtures';

// trg_wallet_ledger_consistency: constraint trigger DEFERRABLE INITIALLY DEFERRED, conferida no COMMIT.
const CONSISTENCY = /trg_wallet_ledger_consistency|does not match|no ledger entries/;

async function walletState(id: string): Promise<{ balance: string; version: string }[]> {
  return appDb()`select balance::text as balance, version::text as version from wallets where id = ${id}`;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe('wallet ↔ ledger consistency (deferred)', () => {
  it('fails the commit of a balance change without a ledger entry', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');

    await expectPgError(
      appDb().begin(async (tx) => {
        await tx`update wallets set balance = balance + 10 where id = ${wallet.id}`;
      }),
      PgError.checkViolation,
      CONSISTENCY,
    );
    expect(await walletState(wallet.id)).toEqual([{ balance: '100.00', version: '1' }]);
  });

  it('commits a balance change with the matching ledger entry', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const win = processedRow(wallet, { kind: 'WIN', amount: '10.00', balance_after_amount: '110.00' });

    await appDb().begin(async (tx) => {
      await insertTransaction(tx, win);
      await tx`update wallets set balance = balance + 10, version = version + 1, updated_at = now() where id = ${wallet.id}`;
      await insertLedgerEntry(
        tx,
        ledgerEntryRow(wallet, win, {
          amount: '10.00',
          balance_before: '100.00',
          balance_after: '110.00',
          wallet_version: 2,
        }),
      );
    });

    expect(await walletState(wallet.id)).toEqual([{ balance: '110.00', version: '2' }]);
  });

  it('checks only at commit: the entry may be inserted after the wallet update', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const bet = processedRow(wallet, { amount: '25.00', balance_after_amount: '75.00' });

    await appDb().begin(async (tx) => {
      await tx`update wallets set balance = balance - 25, version = 2 where id = ${wallet.id}`;
      await insertTransaction(tx, bet);
      await insertLedgerEntry(
        tx,
        ledgerEntryRow(wallet, bet, {
          direction: 'DEBIT',
          amount: '25.00',
          balance_before: '100.00',
          balance_after: '75.00',
          wallet_version: 2,
        }),
      );
    });

    expect(await walletState(wallet.id)).toEqual([{ balance: '75.00', version: '2' }]);
  });

  it('fails when the version is not bumped together with the new entry', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const win = processedRow(wallet, { kind: 'WIN', amount: '10.00' });

    await expectPgError(
      appDb().begin(async (tx) => {
        await insertTransaction(tx, win);
        await tx`update wallets set balance = 110 where id = ${wallet.id}`;
        await insertLedgerEntry(
          tx,
          ledgerEntryRow(wallet, win, {
            amount: '10.00',
            balance_before: '100.00',
            balance_after: '110.00',
            wallet_version: 2,
          }),
        );
      }),
      PgError.checkViolation,
      CONSISTENCY,
    );
    expect(await walletState(wallet.id)).toEqual([{ balance: '100.00', version: '1' }]);
  });

  it('fails a ledger entry inserted without updating the wallet', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const win = await insertTransaction(appDb(), processedRow(wallet, { kind: 'WIN', amount: '10.00' }));

    await expectPgError(
      insertLedgerEntry(
        appDb(),
        ledgerEntryRow(wallet, win, {
          amount: '10.00',
          balance_before: '100.00',
          balance_after: '110.00',
          wallet_version: 2,
        }),
      ),
      PgError.checkViolation,
      CONSISTENCY,
    );
    const rows: { count: string }[] =
      await appDb()`select count(*) from wallet_ledger_entries where wallet_id = ${wallet.id}`;
    expect(rows).toEqual([{ count: '1' }]);
  });

  it('fails opening a wallet with a positive balance and no ledger entry', async () => {
    await expectPgError(insertWallet(appDb(), walletRow({ balance: '50.00' })), PgError.checkViolation, CONSISTENCY);
  });

  it('accepts a zero-balance wallet without entries and a funded opening in one transaction', async () => {
    const empty = await insertWallet(appDb(), walletRow());
    const { wallet } = await insertFundedWallet(appDb(), '1000.00');

    expect(await walletState(empty.id)).toEqual([{ balance: '0.00', version: '1' }]);
    expect(await walletState(wallet.id)).toEqual([{ balance: '1000.00', version: '1' }]);
  });

  it('fails a wallet updated back to zero while it still has entries', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');

    await expectPgError(
      appDb()`update wallets set balance = 0 where id = ${wallet.id}`,
      PgError.checkViolation,
      CONSISTENCY,
    );
  });
});
