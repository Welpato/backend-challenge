import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Cluster } from '../../support/cluster';
import { closeDb, truncateAll } from '../../support/db';
import { LoadClient, simultaneously } from '../../support/load-client';
import { operation, type TransactionInput } from '../../support/wagering-http';
import {
  assertFinalConsistency,
  balancesOf,
  FAST_WORKERS_ENV,
  openWallets,
  statusCounts,
  waitForSettled,
} from './multi-instance-kit';

/**
 * Cenário 7 (F13): REFUND e ROLLBACK chegam **antes** da BET referenciada, por instâncias de API diferentes; as
 * BETs chegam por uma terceira instância; dois reprocessadores (processos reais) resolvem as pendências. As
 * reversões cuja referência nunca chega expiram como `REFERENCE_NOT_FOUND` (TTL curto só neste cenário).
 */
let cluster: Cluster;

const WALLETS = 30;
const ORPHANS = 10;

beforeAll(async () => {
  await truncateAll();
  cluster = await Cluster.start(
    [
      { role: 'api', count: 3 },
      { role: 'reprocessor', count: 2 },
    ],
    { ...FAST_WORKERS_ENV, PENDING_REFERENCE_TTL_MS: '6000' },
  );
}, 60_000);

afterAll(async () => {
  await cluster?.stop();
  await closeDb();
}, 60_000);

describe('multi-instance — scenario 7', () => {
  it('REFUND/ROLLBACK before their BETs on different instances → resolved; orphans expire as REFERENCE_NOT_FOUND', async () => {
    const urls = cluster.apiUrls();
    const client = new LoadClient(urls, 20261007);
    const wallets = await openWallets(urls, WALLETS, '1000.00');
    const reversals: { url: string; input: TransactionInput }[] = [];
    const bets: { url: string; input: TransactionInput }[] = [];
    for (const [w, wallet] of wallets.entries()) {
      const money = { amount: '10.00', currency: 'BRL' };
      reversals.push(
        {
          url: client.at(w),
          input: operation(wallet, { kind: 'REFUND', referenceExternalTransactionId: `bet-a-${w}`, money }),
        },
        {
          url: client.at(w + 1),
          input: operation(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: `bet-b-${w}`, money }),
        },
      );
      bets.push(
        { url: client.at(w + 2), input: operation(wallet, { externalTransactionId: `bet-a-${w}`, money }) },
        { url: client.at(w + 2), input: operation(wallet, { externalTransactionId: `bet-b-${w}`, money }) },
      );
    }
    const orphanWallets = wallets.slice(0, ORPHANS);
    const orphans = orphanWallets.map((wallet, index) => ({
      url: client.at(index),
      input: operation(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: `never-sent-${index}`,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    }));

    const early = await simultaneously(
      [...reversals, ...orphans].map((item) => () => client.submitTo(item.url, item.input)),
    );
    expect(early.map((result) => result.status)).toEqual(Array(early.length).fill(202));
    expect(await statusCounts()).toEqual({ PENDING_REFERENCE: WALLETS * 2 + ORPHANS });

    const late = await simultaneously(bets.map((item) => () => client.submitTo(item.url, item.input)));
    expect(late.map((result) => result.status)).toEqual(Array(late.length).fill(201));

    const counts = await waitForSettled(WALLETS * 4 + ORPHANS, 60_000);
    expect(counts).toEqual({ PROCESSED: WALLETS * 4, REJECTED: ORPHANS });
    // Replays dos órfãos mostram o desfecho final.
    for (const orphan of orphans) {
      const replay = await client.submitTo(client.pick(), orphan.input);
      expect(replay.status).toBe(422);
      expect(replay.body.failureCode).toBe('REFERENCE_NOT_FOUND');
    }
    // −10 −10 (BETs) +10 (REFUND) +10 (ROLLBACK da BET) = saldo inicial.
    expect(await balancesOf(wallets.map((wallet) => wallet.walletId))).toEqual(Array(WALLETS).fill('1000.00'));
    await assertFinalConsistency(
      urls[2] as string,
      wallets.map((wallet) => wallet.walletId),
    );
  }, 120_000);
});
