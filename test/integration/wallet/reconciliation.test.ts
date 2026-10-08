import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Money } from '@/shared/money/money';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { RECONCILIATION_MISMATCHES_METRIC } from '@/wallet/infrastructure/reconciliation-monitor';
import { appDb, closeDb, migratorDb, truncateAll } from '../../support/db';
import { openPersistence, type Persistence } from '../../support/persistence';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import { AT, betFor } from '../persistence/persistence-fixtures';
import { createWallet, expectError, getJson, metricValue, postJson, type WalletJson } from './wallet-test-kit';

interface ReconciliationJson {
  readonly walletId: string;
  readonly storedBalance: { amount: string; currency: string };
  readonly calculatedBalance: { amount: string; currency: string };
  readonly difference: { amount: string; currency: string };
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

let running: RunningTestApp;
let db: Persistence;

beforeAll(async () => {
  running = await startTestApp({ INSTANCE_ID: 'it-wallet-reconcile' });
  db = await openPersistence();
});

afterAll(async () => {
  await running.close();
  await db.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

async function openWallet(amount: string): Promise<WalletJson> {
  const response = await createWallet(running.baseUrl, {
    playerId: `player-${crypto.randomUUID()}`,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(response.status).toBe(201);
  return response.body;
}

/** Débitos via repositórios, um por unidade de trabalho (como o processamento de transação fará). */
async function debit(walletId: string, amounts: readonly string[]): Promise<void> {
  for (const amount of amounts) {
    await db.uow.run(async () => {
      const wallet = await db.wallets.findByIdForUpdate(walletId);
      if (wallet === undefined) {
        throw new Error('wallet not found');
      }
      const tx = betFor(wallet, { kind: WagerTransactionKind.Bet, money: brl(amount) });
      await db.transactions.insertIfAbsent(tx);
      const expectedVersion = wallet.version;
      const entry = wallet.debit(tx.id, brl(amount), AT);
      await db.wallets.updateBalance(wallet, expectedVersion);
      await db.ledger.append(entry);
    });
  }
}

/**
 * Força uma divergência que o schema normalmente impede: como `migrator` (dono da tabela), desliga a constraint
 * trigger de consistência só dentro desta transação (o DDL é transacional) e altera o saldo sem lançamento.
 */
async function corruptBalance(walletId: string, balance: string): Promise<void> {
  await migratorDb().begin(async (sql) => {
    await sql`alter table wallets disable trigger trg_wallet_ledger_consistency`;
    await sql`update wallets set balance = ${balance}::numeric where id = ${walletId}`;
    await sql`alter table wallets enable trigger trg_wallet_ledger_consistency`;
  });
}

function reconcile(walletId: string) {
  return postJson<ReconciliationJson>(running.baseUrl, `/wallets/${walletId}/reconciliation`);
}

describe('POST /wallets/:walletId/reconciliation', () => {
  it('reports a consistent wallet in the challenge format', async () => {
    const wallet = await openWallet('1000.00');
    await debit(wallet.id, ['25.00', '0.01', '100.00']);

    const response = await reconcile(wallet.id);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '874.99', currency: 'BRL' },
      calculatedBalance: { amount: '874.99', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 4,
    });
  });

  it('reports a wallet opened with 0.00 as consistent with 0 entries', async () => {
    const created = await createWallet(running.baseUrl, { playerId: 'zero', currency: 'USD' });
    const response = await reconcile(created.body.id);
    expect(response.body).toEqual({
      walletId: created.body.id,
      storedBalance: { amount: '0.00', currency: 'USD' },
      calculatedBalance: { amount: '0.00', currency: 'USD' },
      difference: { amount: '0.00', currency: 'USD' },
      consistent: true,
      checkedEntries: 0,
    });
  });

  it('reports a wallet opened with 0.00 and then credited as consistent (first entry is version 2)', async () => {
    const created = await createWallet(running.baseUrl, { playerId: `zero-${crypto.randomUUID()}`, currency: 'BRL' });
    expect(created.status).toBe(201);
    const submitted = await fetch(`${running.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'provider-a:zero-win-1' },
      body: JSON.stringify({
        providerId: 'provider-a',
        externalTransactionId: 'zero-win-1',
        playerId: created.body.playerId,
        walletId: created.body.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'WIN',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    });
    expect(submitted.status).toBe(201);
    await debit(created.body.id, ['4.00']);
    const metricBefore = await metricValue(running.baseUrl, RECONCILIATION_MISMATCHES_METRIC);

    const response = await reconcile(created.body.id);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: created.body.id,
      storedBalance: { amount: '6.00', currency: 'BRL' },
      calculatedBalance: { amount: '6.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
    expect(await metricValue(running.baseUrl, RECONCILIATION_MISMATCHES_METRIC)).toBe(metricBefore);
  });

  it('flags a forced mismatch, counts it in the metric and never corrects the balance', async () => {
    const wallet = await openWallet('1000.00');
    await debit(wallet.id, ['25.00']);
    await corruptBalance(wallet.id, '1234.56');
    const metricBefore = await metricValue(running.baseUrl, RECONCILIATION_MISMATCHES_METRIC);

    const response = await reconcile(wallet.id);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '1234.56', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '259.56', currency: 'BRL' },
      consistent: false,
      checkedEntries: 2,
    });
    expect(await metricValue(running.baseUrl, RECONCILIATION_MISMATCHES_METRIC)).toBe(metricBefore + 1);

    // Nunca corrige: saldo gravado continua divergente e nenhum lançamento foi criado.
    const after = await getJson<WalletJson>(running.baseUrl, `/wallets/${wallet.id}`);
    expect(after.body.balance).toEqual({ amount: '1234.56', currency: 'BRL' });
    const [row] =
      await appDb()`select count(*)::int as entries from wallet_ledger_entries where wallet_id = ${wallet.id}`;
    expect(row).toEqual({ entries: 2 });

    // Cada reconciliação divergente conta de novo.
    await reconcile(wallet.id);
    expect(await metricValue(running.baseUrl, RECONCILIATION_MISMATCHES_METRIC)).toBe(metricBefore + 2);
  });

  it('reports a negative difference when the stored balance is below the ledger', async () => {
    const wallet = await openWallet('100.00');
    await corruptBalance(wallet.id, '40.00');
    const response = await reconcile(wallet.id);
    expect(response.body).toMatchObject({
      storedBalance: { amount: '40.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '-60.00', currency: 'BRL' },
      consistent: false,
    });
  });

  it('does not count consistent reconciliations in the metric', async () => {
    const wallet = await openWallet('10.00');
    const before = await metricValue(running.baseUrl, RECONCILIATION_MISMATCHES_METRIC);
    await reconcile(wallet.id);
    await reconcile(wallet.id);
    expect(await metricValue(running.baseUrl, RECONCILIATION_MISMATCHES_METRIC)).toBe(before);
  });

  it('runs in a read-only REPEATABLE READ transaction', async () => {
    const settings = await db.uow.run(
      async (em) =>
        em.execute<{ isolation: string; readOnly: string }>(
          `select current_setting('transaction_isolation') as isolation,
                  current_setting('transaction_read_only') as "readOnly"`,
          [],
          'get',
        ),
      { isolation: 'repeatable read', readOnly: true },
    );
    expect(settings).toEqual({ isolation: 'repeatable read', readOnly: 'on' });
  });

  it('returns 404 WALLET_NOT_FOUND for an unknown wallet and 400 for a non-UUID id', async () => {
    expectError(await reconcile(crypto.randomUUID()), 404, 'WALLET_NOT_FOUND');
    expectError(await reconcile('nope'), 400, 'VALIDATION_ERROR');
  });
});
