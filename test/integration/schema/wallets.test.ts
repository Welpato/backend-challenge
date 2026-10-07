import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { appDb, closeDb, expectPgError, PgError, truncateAll } from '../../support/db';
import { insertWallet, walletRow } from './schema-fixtures';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe('wallets schema', () => {
  it('accepts a zero-balance wallet without ledger entries', async () => {
    const wallet = await insertWallet(appDb(), walletRow());

    const rows: { balance: string; version: string }[] =
      await appDb()`select balance::text as balance, version::text as version from wallets where id = ${wallet.id}`;
    expect(rows).toEqual([{ balance: '0.00', version: '1' }]);
  });

  it('rejects a negative balance', async () => {
    await expectPgError(
      insertWallet(appDb(), walletRow({ balance: '-0.01' })),
      PgError.checkViolation,
      /wallets_balance_check/,
    );
  });

  it('rejects a second wallet for the same player and currency', async () => {
    const first = await insertWallet(appDb(), walletRow());

    await expectPgError(
      insertWallet(appDb(), walletRow({ player_id: first.player_id })),
      PgError.uniqueViolation,
      /uq_wallets_player_currency/,
    );
    // Outra moeda para o mesmo player é permitida.
    await insertWallet(appDb(), walletRow({ player_id: first.player_id, currency: 'USD' }));
  });

  it.each(['brl', 'BR', 'B1L', 'BR '])('rejects currency %p', async (currency) => {
    await expectPgError(
      insertWallet(appDb(), walletRow({ currency })),
      PgError.checkViolation,
      /wallets_currency_check/,
    );
  });

  it('rejects currency codes longer than 3 characters (char(3))', async () => {
    await expectPgError(insertWallet(appDb(), walletRow({ currency: 'BRLX' })), PgError.stringTooLong);
  });

  it('rejects version below 1', async () => {
    await expectPgError(
      insertWallet(appDb(), walletRow({ version: 0 })),
      PgError.checkViolation,
      /wallets_version_check/,
    );
  });

  it('does not let the app role delete wallets', async () => {
    const wallet = await insertWallet(appDb(), walletRow());

    await expectPgError(appDb()`delete from wallets where id = ${wallet.id}`, PgError.insufficientPrivilege);
  });
});
