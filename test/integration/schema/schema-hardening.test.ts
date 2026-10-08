import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQL } from 'bun';
import { appDb, closeDb, expectPgError, migratorDb, PgError, truncateAll } from '../../support/db';
import {
  insertFundedWallet,
  insertLedgerEntry,
  insertTransaction,
  insertWallet,
  type LedgerEntryRow,
  ledgerEntryRow,
  processedRow,
  type TransactionRow,
  transactionRow,
  type WalletRow,
  walletRow,
} from './schema-fixtures';

// Migration 0002_schema_hardening: imutabilidade da wallet, integridade de cada lançamento (no COMMIT) e inbox.
const INTEGRITY = /trg_ledger_entry_integrity|ledger entry/;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

async function walletState(id: string): Promise<{ balance: string; version: string; currency: string }[]> {
  return appDb()`select balance::text as balance, version::text as version, currency from wallets where id = ${id}`;
}

/**
 * Movimento completo e coerente numa transação SQL (transação, saldo/versão +1, lançamento), com o lançamento
 * ajustável para violar uma regra de cada vez.
 */
function movement(
  wallet: WalletRow,
  transaction: TransactionRow,
  newBalance: string,
  newVersion: number,
  entry: Partial<LedgerEntryRow>,
): (tx: SQL) => Promise<void> {
  return async (tx) => {
    await insertTransaction(tx, transaction);
    await tx`update wallets set balance = ${newBalance}::numeric, version = ${newVersion} where id = ${wallet.id}`;
    await insertLedgerEntry(tx, ledgerEntryRow(wallet, transaction, { amount: transaction.amount, ...entry }));
  };
}

describe('wallets are immutable except balance/version (trg_wallets_immutable)', () => {
  it('rejects changing the currency or the player of a wallet, even for the table owner', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');

    await expectPgError(
      appDb()`update wallets set currency = 'USD' where id = ${wallet.id}`,
      PgError.raiseException,
      /immutable columns of wallet .*: currency/,
    );
    await expectPgError(
      migratorDb()`update wallets set player_id = 'someone-else' where id = ${wallet.id}`,
      PgError.raiseException,
      /immutable columns of wallet .*: player_id/,
    );
    expect(await walletState(wallet.id)).toEqual([{ balance: '100.00', version: '1', currency: 'BRL' }]);
  });

  it('requires the version to go up by exactly one when the balance changes, and only then', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');

    await expectPgError(
      appDb()`update wallets set balance = 90, version = 3 where id = ${wallet.id}`,
      PgError.raiseException,
      /version must go from 1 to 2/,
    );
    await expectPgError(
      appDb()`update wallets set balance = 90 where id = ${wallet.id}`,
      PgError.raiseException,
      /version must go from 1 to 2/,
    );
    await expectPgError(
      appDb()`update wallets set version = 2 where id = ${wallet.id}`,
      PgError.raiseException,
      /without a balance change/,
    );
    await appDb()`update wallets set updated_at = now() where id = ${wallet.id}`;
  });

  it('creates wallets only at version 1', async () => {
    await expectPgError(insertWallet(appDb(), walletRow({ version: 2 })), PgError.raiseException, /version 1/);
  });

  it('never deletes a wallet, even for the table owner', async () => {
    const empty = await insertWallet(appDb(), walletRow());
    await expectPgError(
      migratorDb()`delete from wallets where id = ${empty.id}`,
      PgError.raiseException,
      /cannot be deleted/,
    );
  });
});

describe('ledger entry integrity at commit (trg_ledger_entry_integrity)', () => {
  it('accepts a coherent movement', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const bet = processedRow(wallet, { kind: 'BET', amount: '10.00', balance_after_amount: '90.00' });

    await appDb().begin(
      movement(wallet, bet, '90.00', 2, {
        direction: 'DEBIT',
        balance_before: '100.00',
        balance_after: '90.00',
        wallet_version: 2,
      }),
    );
    expect(await walletState(wallet.id)).toEqual([{ balance: '90.00', version: '2', currency: 'BRL' }]);
  });

  it('rejects an entry of a transaction that is not PROCESSED at commit', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const pending = transactionRow(wallet, { kind: 'BET', amount: '10.00' });

    await expectPgError(
      appDb().begin(
        movement(wallet, pending, '90.00', 2, {
          direction: 'DEBIT',
          balance_before: '100.00',
          balance_after: '90.00',
          wallet_version: 2,
        }),
      ),
      PgError.checkViolation,
      /PENDING transaction/,
    );
  });

  it('rejects an entry of a LOSS', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const loss = processedRow(wallet, { kind: 'LOSS', amount: '10.00' });

    await expectPgError(
      appDb().begin(
        movement(wallet, loss, '90.00', 2, {
          direction: 'DEBIT',
          balance_before: '100.00',
          balance_after: '90.00',
          wallet_version: 2,
        }),
      ),
      PgError.checkViolation,
      /LOSS/,
    );
  });

  it('rejects an entry in another wallet than its transaction', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const { wallet: other } = await insertFundedWallet(appDb(), '100.00');
    const betOfOther = processedRow(other, { kind: 'BET', amount: '10.00' });

    await expectPgError(
      appDb().begin(async (tx) => {
        await insertTransaction(tx, betOfOther);
        await tx`update wallets set balance = 90, version = 2 where id = ${wallet.id}`;
        await insertLedgerEntry(
          tx,
          ledgerEntryRow(wallet, betOfOther, {
            direction: 'DEBIT',
            balance_before: '100.00',
            balance_after: '90.00',
            wallet_version: 2,
          }),
        );
      }),
      PgError.checkViolation,
      /another wallet/,
    );
  });

  it('rejects an entry whose amount differs from its transaction', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const bet = processedRow(wallet, { kind: 'BET', amount: '10.00' });

    await expectPgError(
      appDb().begin(
        movement(wallet, bet, '80.00', 2, {
          direction: 'DEBIT',
          amount: '20.00',
          balance_before: '100.00',
          balance_after: '80.00',
          wallet_version: 2,
        }),
      ),
      PgError.checkViolation,
      /amount\/currency differ/,
    );
  });

  it('rejects an entry that is not in the wallet currency', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const usd = processedRow(wallet, { kind: 'WIN', amount: '10.00', currency: 'USD' });

    await expectPgError(
      appDb().begin(
        movement(wallet, usd, '110.00', 2, {
          currency: 'USD',
          balance_before: '100.00',
          balance_after: '110.00',
          wallet_version: 2,
        }),
      ),
      PgError.checkViolation,
      /wallet currency/,
    );
  });

  it('rejects a direction that does not match the kind (BET credited)', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const bet = processedRow(wallet, { kind: 'BET', amount: '10.00' });

    await expectPgError(
      appDb().begin(
        movement(wallet, bet, '110.00', 2, {
          direction: 'CREDIT',
          balance_before: '100.00',
          balance_after: '110.00',
          wallet_version: 2,
        }),
      ),
      PgError.checkViolation,
      /BET must be a DEBIT/,
    );
  });

  it('requires a ROLLBACK to invert the entry of its reference', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const bet = processedRow(wallet, { kind: 'BET', amount: '10.00' });
    await appDb().begin(
      movement(wallet, bet, '90.00', 2, {
        direction: 'DEBIT',
        balance_before: '100.00',
        balance_after: '90.00',
        wallet_version: 2,
      }),
    );
    const rollback = (): TransactionRow =>
      processedRow(wallet, {
        kind: 'ROLLBACK',
        amount: '10.00',
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
      });

    await expectPgError(
      appDb().begin(
        movement(wallet, rollback(), '80.00', 3, {
          direction: 'DEBIT',
          balance_before: '90.00',
          balance_after: '80.00',
          wallet_version: 3,
        }),
      ),
      PgError.checkViolation,
      /ROLLBACK must invert/,
    );
    await appDb().begin(
      movement(wallet, rollback(), '100.00', 3, {
        direction: 'CREDIT',
        balance_before: '90.00',
        balance_after: '100.00',
        wallet_version: 3,
      }),
    );
    expect(await walletState(wallet.id)).toEqual([{ balance: '100.00', version: '3', currency: 'BRL' }]);
  });

  it('rejects an entry that does not continue the chain (balance_before ≠ previous balance_after)', async () => {
    const { wallet } = await insertFundedWallet(appDb(), '100.00');
    const bet = processedRow(wallet, { kind: 'BET', amount: '10.00' });

    // Aritmética do lançamento e wallet × último lançamento fecham; só o encadeamento quebra.
    await expectPgError(
      appDb().begin(
        movement(wallet, bet, '80.00', 2, {
          direction: 'DEBIT',
          balance_before: '90.00',
          balance_after: '80.00',
          wallet_version: 2,
        }),
      ),
      PgError.checkViolation,
      /breaks the chain/,
    );
  });

  it('accepts version 2 as the first entry of a wallet opened with 0.00, and rejects a later first version', async () => {
    const zero = await insertWallet(appDb(), walletRow());
    const win = processedRow(zero, { kind: 'WIN', amount: '10.00' });
    await appDb().begin(
      movement(zero, win, '10.00', 2, { balance_before: '0.00', balance_after: '10.00', wallet_version: 2 }),
    );
    expect(await walletState(zero.id)).toEqual([{ balance: '10.00', version: '2', currency: 'BRL' }]);

    const other = await insertWallet(appDb(), walletRow());
    const late = processedRow(other, { kind: 'WIN', amount: '10.00' });
    await expectPgError(
      appDb().begin(async (tx) => {
        await insertTransaction(tx, late);
        await tx`update wallets set balance = 5, version = 2 where id = ${other.id}`;
        await tx`update wallets set balance = 10, version = 3 where id = ${other.id}`;
        await insertLedgerEntry(
          tx,
          ledgerEntryRow(other, late, { balance_before: '0.00', balance_after: '10.00', wallet_version: 3 }),
        );
      }),
      PgError.checkViolation,
      INTEGRITY,
    );
  });
});

describe('inbox messages (trg_inbox_immutable)', () => {
  async function insertInbox(): Promise<{ consumer: string; messageId: string }> {
    const row = {
      consumer_name: 'wager-transactions',
      message_id: randomUUID(),
      payload_hash: 'c'.repeat(64),
      received_at: new Date('2026-10-08T12:00:00Z'),
    };
    await appDb()`insert into inbox_messages ${appDb()(row)}`;
    return { consumer: row.consumer_name, messageId: row.message_id };
  }

  it('never changes the payload hash', async () => {
    const { consumer, messageId } = await insertInbox();
    await expectPgError(
      appDb()`update inbox_messages set payload_hash = ${'d'.repeat(64)}
        where consumer_name = ${consumer} and message_id = ${messageId}`,
      PgError.raiseException,
      /immutable columns of inbox message .*: payload_hash/,
    );
  });

  it('does not let a processed message become pending again (or be re-stamped)', async () => {
    const { consumer, messageId } = await insertInbox();
    await appDb()`update inbox_messages set processed_at = now()
      where consumer_name = ${consumer} and message_id = ${messageId}`;

    await expectPgError(
      appDb()`update inbox_messages set processed_at = null
        where consumer_name = ${consumer} and message_id = ${messageId}`,
      PgError.raiseException,
      /already processed/,
    );
    await expectPgError(
      appDb()`update inbox_messages set processed_at = now() + interval '1 minute'
        where consumer_name = ${consumer} and message_id = ${messageId}`,
      PgError.raiseException,
      /already processed/,
    );
  });
});
