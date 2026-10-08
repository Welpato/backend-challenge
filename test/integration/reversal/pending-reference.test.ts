import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { appDb, closeDb, truncateAll } from '../../support/db';
import { assertLedgerInvariant } from '../../support/invariants';
import { sleep } from '../../support/persistence';
import { drain, type RunningReprocessor, startReprocessor, statusCounts } from '../../support/reprocessor';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import {
  getJson,
  ledgerRows,
  type OpenedWallet,
  openWallet,
  operation,
  outboxFor,
  submit,
  type TransactionInput,
  walletBalance,
} from '../../support/wagering-http';

let api: RunningTestApp;
let reprocessor: RunningReprocessor;
let wallet: OpenedWallet;

beforeAll(async () => {
  api = await startTestApp({ INSTANCE_ID: 'it-pending-api', PENDING_REFERENCE_BACKOFF_BASE_MS: '1' });
  reprocessor = await startReprocessor({ INSTANCE_ID: 'it-pending-reprocessor-1' });
});

afterAll(async () => {
  await reprocessor.close();
  await api.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
  wallet = await openWallet(api.baseUrl, '100.00');
});

function refundOf(bet: TransactionInput): TransactionInput {
  return operation(wallet, {
    kind: 'REFUND',
    roundId: bet.roundId,
    money: bet.money,
    referenceExternalTransactionId: bet.externalTransactionId,
  });
}

async function pendingRow(id: string) {
  const [row] = await appDb()`
    select status, failure_code, attempts::int, next_attempt_at, balance_after_amount::text
      from wager_transactions where id = ${id}`;
  return row as { status: string; failure_code: string | null; attempts: number; next_attempt_at: Date | null };
}

describe('out-of-order reference (PENDING_REFERENCE)', () => {
  it('REFUND before its BET → 202; the BET arrives; the reprocessor applies the REFUND', async () => {
    const bet = operation(wallet, { money: { amount: '30.00', currency: 'BRL' } });
    const refund = refundOf(bet);

    const pending = await submit(api.baseUrl, refund);
    expect(pending.status).toBe(202);
    expect(pending.body).toEqual({
      transactionId: expect.any(String),
      status: 'PENDING_REFERENCE',
      idempotentReplay: false,
    });
    const refundId = pending.body.transactionId;
    expect(await pendingRow(refundId)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 0 });
    const pendingEvents = await outboxFor(refundId);
    expect(pendingEvents.map((event) => event.event_type)).toEqual(['WagerTransactionPendingReference']);
    expect(pendingEvents[0]?.payload.data).toMatchObject({
      referenceExternalTransactionId: bet.externalTransactionId,
      attempts: 0,
    });

    const pendingReplay = await submit(api.baseUrl, refund);
    expect(pendingReplay.status).toBe(202);
    expect(pendingReplay.body).toEqual({ ...pending.body, idempotentReplay: true });

    expect((await submit(api.baseUrl, bet)).status).toBe(201);
    expect(await walletBalance(wallet.walletId)).toBe('70.00');

    const summary = await reprocessor.worker.runOnce();
    expect(summary).toMatchObject({ claimed: 1, processed: 1 });

    expect(await pendingRow(refundId)).toMatchObject({ status: 'PROCESSED', next_attempt_at: null });
    expect(await walletBalance(wallet.walletId)).toBe('100.00');
    expect((await outboxFor(refundId)).map((event) => event.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const finalReplay = await submit(api.baseUrl, refund);
    expect(finalReplay.status).toBe(200);
    expect(finalReplay.body).toEqual({
      transactionId: refundId,
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    await assertLedgerInvariant([wallet.walletId], { baseUrl: api.baseUrl });
  });

  it('a WIN waiting for its BET is resolved the same way', async () => {
    const bet = operation(wallet);
    const win = operation(wallet, {
      kind: 'WIN',
      money: { amount: '60.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await submit(api.baseUrl, win)).status).toBe(202);
    await submit(api.baseUrl, bet);
    expect(await reprocessor.worker.runOnce()).toMatchObject({ processed: 1 });
    expect(await walletBalance(wallet.walletId)).toBe('135.00');
  });

  it('reschedules with backoff while the reference is still missing (attempts++, no new event)', async () => {
    const refund = refundOf(operation(wallet));
    const pending = await submit(api.baseUrl, refund);
    await sleep(5);

    expect(await reprocessor.worker.runOnce()).toMatchObject({ claimed: 1, rescheduled: 1 });

    const row = await pendingRow(pending.body.transactionId);
    expect(row).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 1 });
    expect(row.next_attempt_at).not.toBeNull();
    expect(await outboxFor(pending.body.transactionId)).toHaveLength(1);
  });

  it('the reference resolves to a rejection (REJECTED reference) → REFERENCE_NOT_PROCESSED with Rejected event', async () => {
    const bet = operation(wallet, { money: { amount: '500.00', currency: 'BRL' } });
    const refund = refundOf(bet);
    const pending = await submit(api.baseUrl, refund);
    expect((await submit(api.baseUrl, bet)).status).toBe(422);

    expect(await reprocessor.worker.runOnce()).toMatchObject({ rejected: 1 });
    expect(await pendingRow(pending.body.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_PROCESSED',
    });
    expect((await submit(api.baseUrl, refund)).status).toBe(422);
  });

  it('shows the pending state in the GET endpoint', async () => {
    const pending = await submit(api.baseUrl, refundOf(operation(wallet)));
    const view = await getJson(api.baseUrl, `/wagering/transactions/${pending.body.transactionId}`);
    expect(view.body).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 0, nextAttemptAt: expect.any(String) });
    expect(view.body).not.toHaveProperty('balanceAfter');
  });
});

describe('expiration', () => {
  it('after the TTL the pending transaction is REJECTED REFERENCE_NOT_FOUND with a Rejected event', async () => {
    const shortTtl = await startReprocessor({ INSTANCE_ID: 'it-pending-ttl', PENDING_REFERENCE_TTL_MS: '1000' });
    try {
      const refund = refundOf(operation(wallet));
      const pending = await submit(api.baseUrl, refund);
      await sleep(1_050);

      expect(await shortTtl.worker.runOnce()).toMatchObject({ claimed: 1, expired: 1 });

      const id = pending.body.transactionId;
      expect(await pendingRow(id)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
      const events = await outboxFor(id);
      expect(events.map((event) => event.event_type)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionRejected',
      ]);
      expect(events[1]?.payload.data).toMatchObject({
        failureCode: 'REFERENCE_NOT_FOUND',
        referenceExternalTransactionId: refund.referenceExternalTransactionId,
      });
      const replay = await submit(api.baseUrl, refund);
      expect(replay.status).toBe(422);
      expect(replay.body).toMatchObject({ failureCode: 'REFERENCE_NOT_FOUND', idempotentReplay: true });
      await assertLedgerInvariant([wallet.walletId]);
    } finally {
      await shortTtl.close();
    }
  });

  it('after the maximum number of attempts the pending transaction is REFERENCE_NOT_FOUND', async () => {
    const twoAttempts = await startReprocessor({ INSTANCE_ID: 'it-pending-max', PENDING_REFERENCE_MAX_ATTEMPTS: '2' });
    try {
      const pending = await submit(api.baseUrl, refundOf(operation(wallet)));
      const outcomes: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        await sleep(10);
        const summary = await twoAttempts.worker.runOnce();
        outcomes.push(
          ...Object.entries(summary)
            .filter(([key, n]) => key !== 'claimed' && n > 0)
            .map(([key]) => key),
        );
      }
      expect(outcomes).toEqual(['rescheduled', 'rescheduled', 'expired']);
      expect(await pendingRow(pending.body.transactionId)).toMatchObject({
        status: 'REJECTED',
        failure_code: 'REFERENCE_NOT_FOUND',
        attempts: 2,
      });
    } finally {
      await twoAttempts.close();
    }
  });
});

describe('concurrent reprocessors', () => {
  it('two reprocessors over 100 pending transactions resolve each exactly once, without deadlocks', async () => {
    const workerA = await startReprocessor({ INSTANCE_ID: 'it-pending-a', REPROCESSOR_BATCH_SIZE: '7' });
    const workerB = await startReprocessor({ INSTANCE_ID: 'it-pending-b', REPROCESSOR_BATCH_SIZE: '7' });
    try {
      const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(api.baseUrl, '1000.00')));
      const pairs = wallets.flatMap((owner) =>
        Array.from({ length: 10 }, () => {
          const bet = operation(owner, { money: { amount: '10.00', currency: 'BRL' } });
          const refund = operation(owner, {
            kind: 'REFUND',
            money: bet.money,
            referenceExternalTransactionId: bet.externalTransactionId,
          });
          return { bet, refund };
        }),
      );
      const refunds = await Promise.all(pairs.map(({ refund }) => submit(api.baseUrl, refund)));
      expect(refunds.every((response) => response.status === 202)).toBe(true);
      const bets = await Promise.all(pairs.map(({ bet }) => submit(api.baseUrl, bet)));
      expect(bets.every((response) => response.status === 201)).toBe(true);

      const [a, b] = await Promise.all([drain(workerA.worker), drain(workerB.worker)]);

      expect((a?.processed ?? 0) + (b?.processed ?? 0)).toBe(100);
      expect((a?.errors ?? 0) + (b?.errors ?? 0)).toBe(0);
      expect(a?.processed).toBeGreaterThan(0);
      expect(b?.processed).toBeGreaterThan(0);
      expect(await statusCounts()).toEqual({ PROCESSED: 200 });
      for (const owner of wallets) {
        expect(await walletBalance(owner.walletId)).toBe('1000.00');
        expect(await ledgerRows(owner.walletId)).toHaveLength(20);
      }
      await assertLedgerInvariant(wallets.map((owner) => owner.walletId));
    } finally {
      await Promise.all([workerA.close(), workerB.close()]);
    }
  }, 60_000);

  it('the real loop of the reprocessor role resolves pending transactions in the background', async () => {
    const live = await startTestApp({
      APP_ROLE: 'reprocessor',
      INSTANCE_ID: 'it-pending-live',
      REPROCESSOR_INTERVAL_MS: '50',
    });
    try {
      const bet = operation(wallet);
      const pending = await submit(api.baseUrl, refundOf(bet));
      await submit(api.baseUrl, bet);
      let status = '';
      for (let i = 0; i < 100 && status !== 'PROCESSED'; i += 1) {
        await sleep(20);
        status = (await pendingRow(pending.body.transactionId)).status;
      }
      expect(status).toBe('PROCESSED');
      const metrics = await (await fetch(`${live.baseUrl}/metrics`)).text();
      expect(metrics).toContain('pending_references{');
    } finally {
      await live.close();
    }
  }, 20_000);
});
