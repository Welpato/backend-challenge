import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { appDb, closeDb, expectPgError, migratorDb, PgError, truncateAll } from '../../support/db';
import {
  insertTransaction,
  insertWallet,
  processedRow,
  transactionRow,
  type WalletRow,
  walletRow,
} from './schema-fixtures';

let wallet: WalletRow;

beforeEach(async () => {
  await truncateAll();
  wallet = await insertWallet(appDb(), walletRow());
});

afterAll(async () => {
  await closeDb();
});

describe('wager_transactions uniqueness', () => {
  it('rejects a duplicate idempotency_key', async () => {
    const first = await insertTransaction(appDb(), transactionRow(wallet));

    await expectPgError(
      insertTransaction(appDb(), transactionRow(wallet, { idempotency_key: first.idempotency_key })),
      PgError.uniqueViolation,
      /uq_wager_transactions_idempotency_key/,
    );
  });

  it('rejects a duplicate (provider_id, external_transaction_id)', async () => {
    const first = await insertTransaction(appDb(), transactionRow(wallet));

    await expectPgError(
      insertTransaction(appDb(), transactionRow(wallet, { external_transaction_id: first.external_transaction_id })),
      PgError.uniqueViolation,
      /uq_wager_transactions_provider_external/,
    );
    // O mesmo external id em outro provedor é outra transação.
    await insertTransaction(
      appDb(),
      transactionRow(wallet, { provider_id: 'provider-b', external_transaction_id: first.external_transaction_id }),
    );
  });

  it('allows a single PROCESSED REFUND/ROLLBACK per referenced transaction', async () => {
    const bet = await insertTransaction(appDb(), processedRow(wallet));
    const reversal = (kind: string) =>
      processedRow(wallet, {
        kind,
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
      });
    await insertTransaction(appDb(), reversal('REFUND'));

    await expectPgError(insertTransaction(appDb(), reversal('ROLLBACK')), PgError.uniqueViolation, /ux_reversal_once/);
    await expectPgError(insertTransaction(appDb(), reversal('REFUND')), PgError.uniqueViolation, /ux_reversal_once/);

    // Reversões não PROCESSED (ex.: REJECTED ALREADY_REVERSED) não contam para o índice parcial.
    await insertTransaction(
      appDb(),
      transactionRow(wallet, {
        kind: 'ROLLBACK',
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
        status: 'REJECTED',
        failure_code: 'ALREADY_REVERSED',
      }),
    );
  });

  it('rejects a second reversal reaching PROCESSED through an UPDATE', async () => {
    const bet = await insertTransaction(appDb(), processedRow(wallet));
    const refund = (status: string) =>
      transactionRow(wallet, {
        kind: 'REFUND',
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
        status,
        ...(status === 'PROCESSED' ? { balance_after_amount: '10.00', balance_after_currency: 'BRL' } : {}),
      });
    await insertTransaction(appDb(), refund('PROCESSED'));
    const pending = await insertTransaction(appDb(), refund('PENDING'));

    await expectPgError(
      appDb()`update wager_transactions set status = 'PROCESSED' where id = ${pending.id}`,
      PgError.uniqueViolation,
      /ux_reversal_once/,
    );
  });
});

describe('wager_transactions checks', () => {
  it.each(['REFUND', 'ROLLBACK'])('rejects %s without reference_external_transaction_id', async (kind) => {
    await expectPgError(
      insertTransaction(appDb(), transactionRow(wallet, { kind })),
      PgError.checkViolation,
      /ck_wager_transactions_reversal_reference/,
    );
  });

  it.each(['REJECTED', 'FAILED'])('rejects %s without failure_code', async (status) => {
    await expectPgError(
      insertTransaction(appDb(), transactionRow(wallet, { status })),
      PgError.checkViolation,
      /ck_wager_transactions_failure_code/,
    );
  });

  it('rejects failure_code on a non-failed status', async () => {
    await expectPgError(
      insertTransaction(appDb(), processedRow(wallet, { failure_code: 'INSUFFICIENT_FUNDS' })),
      PgError.checkViolation,
      /ck_wager_transactions_failure_code/,
    );
  });

  it.each(['BET', 'WIN', 'OPENING'])('rejects amount 0 for %s', async (kind) => {
    await expectPgError(
      insertTransaction(appDb(), transactionRow(wallet, { kind, amount: '0.00' })),
      PgError.checkViolation,
      /ck_wager_transactions_positive_amount/,
    );
  });

  it('accepts LOSS with amount 0.00 and rejects negative amounts', async () => {
    await insertTransaction(appDb(), processedRow(wallet, { kind: 'LOSS', amount: '0.00' }));

    await expectPgError(
      insertTransaction(appDb(), transactionRow(wallet, { kind: 'LOSS', amount: '-1.00' })),
      PgError.checkViolation,
      /wager_transactions_amount_check/,
    );
  });

  it('requires next_attempt_at in PENDING_REFERENCE and a complete balance snapshot', async () => {
    await expectPgError(
      insertTransaction(appDb(), transactionRow(wallet, { status: 'PENDING_REFERENCE' })),
      PgError.checkViolation,
      /ck_wager_transactions_pending_reference_schedule/,
    );
    await expectPgError(
      insertTransaction(appDb(), processedRow(wallet, { balance_after_currency: null })),
      PgError.checkViolation,
      /ck_wager_transactions_balance_after_pair/,
    );
  });

  it('rejects unknown kinds and statuses', async () => {
    await expectPgError(insertTransaction(appDb(), transactionRow(wallet, { kind: 'BONUS' })), PgError.checkViolation);
    await expectPgError(insertTransaction(appDb(), transactionRow(wallet, { status: 'DONE' })), PgError.checkViolation);
  });
});

describe('wager_transactions immutability (trg_tx_immutable)', () => {
  it('allows state-transition columns to change while the transaction is not final', async () => {
    const tx = await insertTransaction(appDb(), transactionRow(wallet));

    await appDb()`update wager_transactions
      set status = 'PENDING_REFERENCE', attempts = 1, next_attempt_at = now(), updated_at = now()
      where id = ${tx.id}`;
    await appDb()`update wager_transactions
      set status = 'PROCESSED', next_attempt_at = null, processed_at = now(), updated_at = now(),
          balance_after_amount = '0.00', balance_after_currency = 'BRL'
      where id = ${tx.id}`;

    const rows: { status: string; attempts: number }[] =
      await appDb()`select status, attempts from wager_transactions where id = ${tx.id}`;
    expect(rows).toEqual([{ status: 'PROCESSED', attempts: 1 }]);
  });

  it.each([
    ['PROCESSED', {}],
    ['REJECTED', { failure_code: 'INSUFFICIENT_FUNDS' }],
    ['FAILED', { failure_code: 'PROCESSING_FAILED' }],
  ])('rejects any UPDATE after %s', async (status, extra) => {
    const tx = await insertTransaction(appDb(), processedRow(wallet, { status, ...extra }));

    await expectPgError(
      appDb()`update wager_transactions set updated_at = now() where id = ${tx.id}`,
      PgError.raiseException,
      /is final/,
    );
    await expectPgError(
      migratorDb()`update wager_transactions set status = 'PENDING', failure_code = null where id = ${tx.id}`,
      PgError.raiseException,
      /is final/,
    );
  });

  it.each([
    ['amount', '99.00'],
    ['provider_id', 'provider-z'],
    ['external_transaction_id', 'other-ext'],
    ['idempotency_key', 'other-key'],
    ['payload_hash', 'b'.repeat(64)],
    ['player_id', 'other-player'],
    ['round_id', 'other-round'],
    ['game_id', 'other-game'],
    ['kind', 'WIN'],
    ['currency', 'USD'],
    ['reference_external_transaction_id', 'other-ref'],
    ['correlation_id', 'other-corr'],
  ])('rejects changing %s even before the transaction is final', async (column, value) => {
    const tx = await insertTransaction(appDb(), transactionRow(wallet));

    await expectPgError(
      appDb()`update wager_transactions set ${appDb()({ [column]: value })} where id = ${tx.id}`,
      PgError.raiseException,
      new RegExp(`immutable columns .*: ${column}$`),
    );
  });

  it('rejects moving a transaction to another wallet', async () => {
    const other = await insertWallet(appDb(), walletRow({ player_id: wallet.player_id, currency: 'USD' }));
    const tx = await insertTransaction(appDb(), transactionRow(wallet));

    await expectPgError(
      appDb()`update wager_transactions set wallet_id = ${other.id} where id = ${tx.id}`,
      PgError.raiseException,
      /immutable columns .*: wallet_id$/,
    );
  });

  it('blocks DELETE (trigger for the owner, permission for the app role)', async () => {
    const tx = await insertTransaction(appDb(), transactionRow(wallet));

    await expectPgError(
      migratorDb()`delete from wager_transactions where id = ${tx.id}`,
      PgError.raiseException,
      /cannot be deleted/,
    );
    await expectPgError(appDb()`delete from wager_transactions where id = ${tx.id}`, PgError.insufficientPrivilege);
  });
});
