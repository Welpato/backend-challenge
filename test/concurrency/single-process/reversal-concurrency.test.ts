import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { appDb, closeDb, truncateAll } from '../../support/db';
import { assertLedgerInvariant } from '../../support/invariants';
import { drain, type RunningReprocessor, startReprocessor, statusCounts } from '../../support/reprocessor';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import { ledgerRows, openWallet, operation, submit, walletBalance } from '../../support/wagering-http';

/** Reversões concorrentes numa instância (F10), com o reprocessador real dirigido por `runOnce`. */
let api: RunningTestApp;
let reprocessor: RunningReprocessor;

beforeAll(async () => {
  api = await startTestApp({ INSTANCE_ID: 'cc-reversal-api', PENDING_REFERENCE_BACKOFF_BASE_MS: '1' });
  reprocessor = await startReprocessor({ INSTANCE_ID: 'cc-reversal-reprocessor' });
});

afterAll(async () => {
  await reprocessor.close();
  await api.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

describe('reversals under concurrency', () => {
  it('REFUND and its BET sent at the same time (50 pairs) all end PROCESSED once the reprocessor runs', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(api.baseUrl, '1000.00')));
    const requests = wallets.flatMap((wallet) =>
      Array.from({ length: 10 }, () => {
        const bet = operation(wallet, { money: { amount: '15.00', currency: 'BRL' } });
        const refund = operation(wallet, {
          kind: 'REFUND',
          money: bet.money,
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        return [submit(api.baseUrl, refund), submit(api.baseUrl, bet)];
      }),
    );

    const responses = await Promise.all(requests.flat());

    expect(responses.every((response) => [201, 202].includes(response.status))).toBe(true);
    await drain(reprocessor.worker);
    expect(await statusCounts()).toEqual({ PROCESSED: 100 });
    for (const wallet of wallets) {
      expect(await walletBalance(wallet.walletId)).toBe('1000.00');
    }
    await assertLedgerInvariant(
      wallets.map((wallet) => wallet.walletId),
      { baseUrl: api.baseUrl },
    );
  }, 60_000);

  it('REFUND and ROLLBACK of the same BET in parallel (×20) → exactly one reversal applied', async () => {
    const walletIds: string[] = [];
    for (let round = 0; round < 20; round += 1) {
      const wallet = await openWallet(api.baseUrl, '100.00');
      walletIds.push(wallet.walletId);
      const bet = operation(wallet, { money: { amount: '40.00', currency: 'BRL' } });
      expect((await submit(api.baseUrl, bet)).status).toBe(201);
      const reversals = (['REFUND', 'ROLLBACK'] as const).map((kind) =>
        operation(wallet, { kind, money: bet.money, referenceExternalTransactionId: bet.externalTransactionId }),
      );

      const responses = await Promise.all(reversals.map((reversal) => submit(api.baseUrl, reversal)));

      expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
      expect(responses.find((response) => response.status === 422)?.body.failureCode).toBe('ALREADY_REVERSED');
      expect(await walletBalance(wallet.walletId)).toBe('100.00');
      expect((await ledgerRows(wallet.walletId)).map((row) => row.direction)).toEqual(['DEBIT', 'CREDIT']);
    }
    const [row] = await appDb()`
      select count(*)::int as n from wager_transactions
       where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'`;
    expect(row).toEqual({ n: 20 });
    await assertLedgerInvariant(walletIds);
  }, 60_000);
});
