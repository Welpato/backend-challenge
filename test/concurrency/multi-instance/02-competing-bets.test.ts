import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Cluster } from '../../support/cluster';
import { closeDb, truncateAll } from '../../support/db';
import { LoadClient, simultaneously } from '../../support/load-client';
import { ledgerRows, openWallet, operation, walletBalance } from '../../support/wagering-http';
import { assertFinalConsistency } from './multi-instance-kit';

/** Cenário 2 (F13) — o cenário obrigatório de DESAFIO.md §8, com as duas apostas em processos diferentes. */
let cluster: Cluster;

beforeAll(async () => {
  await truncateAll();
  cluster = await Cluster.start([{ role: 'api', count: 3 }]);
}, 60_000);

afterAll(async () => {
  await cluster.stop();
  await closeDb();
}, 60_000);

describe('multi-instance — scenario 2', () => {
  it('100.00 BRL and two simultaneous 80.00 BETs on different APIs (×20) → always 1 PROCESSED, 1 REJECTED, 20.00, 1 DEBIT', async () => {
    const urls = cluster.apiUrls();
    const client = new LoadClient(urls, 20261002);
    const walletIds: string[] = [];
    for (let round = 0; round < 20; round += 1) {
      const wallet = await openWallet(client.at(round), '100.00');
      walletIds.push(wallet.walletId);
      const bets = [0, 1].map(() => operation(wallet, { money: { amount: '80.00', currency: 'BRL' } }));
      const targets = [client.at(round), client.at(round + 1)];

      const results = await simultaneously(
        bets.map((bet, index) => () => client.submitTo(targets[index] as string, bet)),
      );

      expect(results.map((result) => result.status).sort()).toEqual([201, 422]);
      expect(results.find((result) => result.status === 422)?.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '20.00', currency: 'BRL' },
      });
      expect(await walletBalance(wallet.walletId)).toBe('20.00');
      expect((await ledgerRows(wallet.walletId)).filter((row) => row.direction === 'DEBIT')).toHaveLength(1);

      // "Nenhum retry duplica o débito": reenviar as duas, agora trocando as instâncias.
      const retried = await simultaneously(
        bets.map((bet, index) => () => client.submitTo(targets[1 - index] as string, bet)),
      );
      expect(retried.map((result) => result.status).sort()).toEqual([200, 422]);
      expect(retried.every((result) => result.body.idempotentReplay)).toBe(true);
      expect(await ledgerRows(wallet.walletId)).toHaveLength(1);
    }
    await assertFinalConsistency(urls[0] as string, walletIds);
  }, 120_000);
});
