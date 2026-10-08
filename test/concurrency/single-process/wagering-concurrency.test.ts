import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { appDb, closeDb, truncateAll } from '../../support/db';
import { assertLedgerInvariant } from '../../support/invariants';
import { seededRandom } from '../../support/seeded-random';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import {
  ledgerRows,
  type OpenedWallet,
  openWallet,
  operation,
  submit,
  type TransactionInput,
  walletBalance,
} from '../../support/wagering-http';

/**
 * Concorrência numa instância (F09): requisições HTTP realmente paralelas contra a app real, com o pool de
 * conexões real do MikroORM e o PostgreSQL da infra de teste. Multi-processo/multi-instância fica na F13.
 */
let running: RunningTestApp;

beforeAll(async () => {
  running = await startTestApp({ INSTANCE_ID: 'cc-single-process' });
});

afterAll(async () => {
  await running.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
});

function cents(amount: number): string {
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}

describe('single process, real connection pool', () => {
  it('the same BET sent 50× in parallel → 1 PROCESSED, 49 identical replays, 1 DEBIT', async () => {
    const wallet = await openWallet(running.baseUrl, '1000.00');
    const bet = operation(wallet);

    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(running.baseUrl, bet)));

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([...Array(49).fill(200), 201]);
    const first = responses.find((response) => response.status === 201);
    for (const response of responses.filter((candidate) => candidate.status === 200)) {
      expect(response.body).toEqual({ ...first?.body, idempotentReplay: true } as typeof response.body);
    }
    expect(first?.body.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    expect(await ledgerRows(wallet.walletId)).toHaveLength(1);
    expect(await walletBalance(wallet.walletId)).toBe('975.00');
    await assertLedgerInvariant([wallet.walletId], { baseUrl: running.baseUrl });
  }, 30_000);

  it('100.00 and two simultaneous 80.00 BETs (×20) → always 1 PROCESSED, 1 REJECTED, balance 20.00, 1 DEBIT', async () => {
    const walletIds: string[] = [];
    for (let round = 0; round < 20; round += 1) {
      const wallet = await openWallet(running.baseUrl, '100.00');
      walletIds.push(wallet.walletId);
      const bets = [0, 1].map(() => operation(wallet, { money: { amount: '80.00', currency: 'BRL' } }));

      const responses = await Promise.all(bets.map((bet) => submit(running.baseUrl, bet)));

      expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
      const rejected = responses.find((response) => response.status === 422);
      expect(rejected?.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
      expect(await walletBalance(wallet.walletId)).toBe('20.00');
      const debits = (await ledgerRows(wallet.walletId)).filter((row) => row.direction === 'DEBIT');
      expect(debits).toHaveLength(1);

      // Reenviar as duas apostas não duplica nada: são replays com o resultado original.
      const retried = await Promise.all(bets.map((bet) => submit(running.baseUrl, bet)));
      expect(retried.map((response) => response.status).sort()).toEqual([200, 422]);
      expect(retried.every((response) => response.body.idempotentReplay)).toBe(true);
      expect(await ledgerRows(wallet.walletId)).toHaveLength(1);
    }
    await assertLedgerInvariant(walletIds, { baseUrl: running.baseUrl });
  }, 60_000);

  it('200 mixed operations (with duplicates) on one wallet keep the ledger invariant', async () => {
    const wallet = await openWallet(running.baseUrl, '500.00');
    const random = seededRandom(20261007);
    const kinds = ['BET', 'BET', 'BET', 'WIN', 'LOSS'] as const;
    const unique: TransactionInput[] = Array.from({ length: 160 }, () => {
      const kind = kinds[Math.floor(random() * kinds.length)] ?? 'BET';
      return operation(wallet, { kind, money: { amount: cents(1 + Math.floor(random() * 5_000)), currency: 'BRL' } });
    });
    // 40 reenvios de operações já sorteadas, misturados no mesmo lote.
    const duplicates = Array.from(
      { length: 40 },
      (_, index) => unique[(index * 7) % unique.length] as TransactionInput,
    );
    const batch = [...unique, ...duplicates].sort(() => random() - 0.5);

    const responses = await Promise.all(batch.map((input) => submit(running.baseUrl, input)));

    expect(responses.every((response) => [200, 201, 422].includes(response.status))).toBe(true);
    const [summary] = await appDb()`
      select count(*) filter (where status = 'PROCESSED' and kind in ('BET','WIN'))::int as moving,
             count(*)::int as total
        from wager_transactions where wallet_id = ${wallet.walletId} and kind <> 'OPENING'`;
    expect(summary).toMatchObject({ total: unique.length });
    expect(await ledgerRows(wallet.walletId)).toHaveLength((summary as { moving: number }).moving);
    await assertLedgerInvariant([wallet.walletId], { baseUrl: running.baseUrl });
  }, 60_000);

  it('50 wallets processed in parallel all stay consistent', async () => {
    const wallets: OpenedWallet[] = await Promise.all(
      Array.from({ length: 50 }, () => openWallet(running.baseUrl, '100.00')),
    );
    const random = seededRandom(7);
    const batch = wallets.flatMap((wallet) =>
      Array.from({ length: 8 }, () =>
        operation(wallet, {
          kind: random() < 0.7 ? 'BET' : 'WIN',
          money: { amount: cents(100 + Math.floor(random() * 3_000)), currency: 'BRL' },
        }),
      ),
    );

    const responses = await Promise.all(batch.map((input) => submit(running.baseUrl, input)));

    expect(responses.every((response) => response.status === 201 || response.status === 422)).toBe(true);
    await assertLedgerInvariant(
      wallets.map((wallet) => wallet.walletId),
      { baseUrl: running.baseUrl },
    );
  }, 60_000);
});
