import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Cluster } from '../../support/cluster';
import { closeDb, truncateAll } from '../../support/db';
import { LoadClient } from '../../support/load-client';
import { ledgerRows, openWallet, operation, walletBalance } from '../../support/wagering-http';
import { assertFinalConsistency } from './multi-instance-kit';

/** Cenário 1 (F13): a mesma BET 50× em paralelo, distribuída entre 3 processos de API. */
let cluster: Cluster;

beforeAll(async () => {
  await truncateAll();
  cluster = await Cluster.start([{ role: 'api', count: 3 }]);
}, 60_000);

afterAll(async () => {
  await cluster.stop();
  await closeDb();
}, 60_000);

describe('multi-instance — scenario 1', () => {
  it('the same BET 50× across 3 API processes → 1 DEBIT, 1×201 and 49 identical replays', async () => {
    const urls = cluster.apiUrls();
    const wallet = await openWallet(urls[0] as string, '1000.00');
    const bet = operation(wallet);
    const client = new LoadClient(urls, 20261001);

    const results = await client.submitAll(Array.from({ length: 50 }, () => bet));

    expect(results.map((result) => result.status).sort()).toEqual([...Array(49).fill(200), 201]);
    expect(new Set(results.map((result) => result.url)).size).toBe(3);
    const first = results.find((result) => result.status === 201);
    expect(first?.body.balance).toEqual({ amount: '975.00', currency: 'BRL' });
    for (const replay of results.filter((result) => result.status === 200)) {
      expect(replay.body).toEqual({ ...first?.body, idempotentReplay: true } as typeof replay.body);
    }
    expect(await ledgerRows(wallet.walletId)).toHaveLength(1);
    expect(await walletBalance(wallet.walletId)).toBe('975.00');
    await assertFinalConsistency(urls[2] as string, [wallet.walletId]);
  }, 60_000);
});
