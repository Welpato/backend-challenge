import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { appDb, closeDb, expectPgError, migratorDb, PgError, truncateAll } from '../../support/db';
import {
  insertFundedWallet,
  insertLedgerEntry,
  insertTransaction,
  insertWallet,
  ledgerEntryRow,
  processedRow,
  walletRow,
} from './schema-fixtures';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe('wallet_ledger_entries schema', () => {
  it('accepts a balanced entry (credit opening 0 → 100.00)', async () => {
    const { entry } = await insertFundedWallet(appDb(), '100.00');

    const rows: { balance_after: string }[] =
      await appDb()`select balance_after from wallet_ledger_entries where id = ${entry.id}`;
    expect(rows).toEqual([{ balance_after: '100.00' }]);
  });

  it.each([
    ['CREDIT', '10.00', '0.00', '10.01'],
    ['CREDIT', '10.00', '5.00', '5.00'],
    ['DEBIT', '10.00', '50.00', '60.00'],
    ['DEBIT', '10.00', '50.00', '39.99'],
  ])('rejects wrong arithmetic: %s %s from %s to %s', async (direction, amount, before, after) => {
    const wallet = await insertWallet(appDb(), walletRow());
    const tx = await insertTransaction(appDb(), processedRow(wallet, { amount }));

    await expectPgError(
      insertLedgerEntry(
        appDb(),
        ledgerEntryRow(wallet, tx, { direction, amount, balance_before: before, balance_after: after }),
      ),
      PgError.checkViolation,
      /ck_ledger_arithmetic/,
    );
  });

  it('rejects amount = 0 and negative balances', async () => {
    const wallet = await insertWallet(appDb(), walletRow());
    const tx = await insertTransaction(appDb(), processedRow(wallet));

    await expectPgError(
      insertLedgerEntry(
        appDb(),
        ledgerEntryRow(wallet, tx, { amount: '0.00', balance_before: '0.00', balance_after: '0.00' }),
      ),
      PgError.checkViolation,
      /wallet_ledger_entries_amount_check/,
    );
    await expectPgError(
      insertLedgerEntry(
        appDb(),
        ledgerEntryRow(wallet, tx, {
          direction: 'DEBIT',
          amount: '10.00',
          balance_before: '5.00',
          balance_after: '-5.00',
        }),
      ),
      PgError.checkViolation,
      /wallet_ledger_entries_balance_after_check/,
    );
  });

  it('rejects two entries for the same (wallet_id, wallet_version)', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const bet = await insertTransaction(appDb(), processedRow(wallet));

    await expectPgError(
      insertLedgerEntry(
        appDb(),
        ledgerEntryRow(wallet, bet, {
          direction: 'DEBIT',
          amount: '10.00',
          balance_before: '100.00',
          balance_after: '90.00',
          wallet_version: 1,
        }),
      ),
      PgError.uniqueViolation,
      /uq_ledger_wallet_version/,
    );
  });

  it('rejects two entries for the same transaction', async () => {
    const { wallet, opening } = await insertFundedWallet(appDb(), '100.00');

    await expectPgError(
      insertLedgerEntry(
        appDb(),
        ledgerEntryRow(wallet, opening, { balance_before: '100.00', balance_after: '200.00', wallet_version: 2 }),
      ),
      PgError.uniqueViolation,
      /uq_ledger_transaction_wallet/,
    );
  });

  it('blocks UPDATE and DELETE even for the table owner (trigger)', async () => {
    const { entry } = await insertFundedWallet(appDb(), '100.00');

    await expectPgError(
      migratorDb()`update wallet_ledger_entries set amount = 1 where id = ${entry.id}`,
      PgError.raiseException,
      /ledger is append-only/,
    );
    await expectPgError(
      migratorDb()`delete from wallet_ledger_entries where id = ${entry.id}`,
      PgError.raiseException,
      /ledger is append-only/,
    );
  });

  it('denies UPDATE and DELETE to the app role (permission)', async () => {
    const { entry } = await insertFundedWallet(appDb(), '100.00');

    await expectPgError(
      appDb()`update wallet_ledger_entries set amount = 1 where id = ${entry.id}`,
      PgError.insufficientPrivilege,
    );
    await expectPgError(
      appDb()`delete from wallet_ledger_entries where id = ${entry.id}`,
      PgError.insufficientPrivilege,
    );

    const rows: { count: string }[] = await appDb()`select count(*) from wallet_ledger_entries`;
    expect(rows).toEqual([{ count: '1' }]);
  });
});
