import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Cluster } from '../../support/cluster';
import { closeDb, truncateAll } from '../../support/db';
import { LoadClient } from '../../support/load-client';
import { seededRandom } from '../../support/seeded-random';
import { ledgerRows, operation, type TransactionInput } from '../../support/wagering-http';
import { amountOf, assertFinalConsistency, openWallets } from './multi-instance-kit';

/** Cenário 3 (F13): 50 wallets em paralelo, 20 operações cada, espalhadas por 3 processos de API. */
let cluster: Cluster;

beforeAll(async () => {
  await truncateAll();
  cluster = await Cluster.start([{ role: 'api', count: 3 }]);
}, 60_000);

afterAll(async () => {
  await cluster.stop();
  await closeDb();
}, 60_000);

describe('multi-instance — scenario 3', () => {
  it('50 wallets × 20 operations (BET/WIN/LOSS, some over the balance) on 3 APIs → every wallet consistent', async () => {
    const urls = cluster.apiUrls();
    const wallets = await openWallets(urls, 50, '100.00');
    const random = seededRandom(20261003);
    const inputs: TransactionInput[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < 20; i += 1) {
        const roll = random();
        const kind = roll < 0.6 ? 'BET' : roll < 0.85 ? 'WIN' : 'LOSS';
        // Até 30.00 por operação: com 100.00 de saldo, várias BETs concorrentes estouram e viram REJECTED.
        const cents = kind === 'LOSS' ? 0 : 1 + Math.floor(random() * 3000);
        inputs.push(operation(wallet, { kind, money: { amount: amountOf(cents), currency: 'BRL' } }));
      }
    }

    const results = await new LoadClient(urls, 20261003).submitAll(inputs);

    expect(results.filter((result) => ![201, 422].includes(result.status))).toEqual([]);
    const rejected = results.filter((result) => result.status === 422);
    expect(rejected.every((result) => result.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    // Um lançamento por BET/WIN processada, nenhum por LOSS ou rejeição.
    const moving = results.filter(
      (result, index) => result.status === 201 && (inputs[index] as TransactionInput).kind !== 'LOSS',
    ).length;
    let entries = 0;
    for (const wallet of wallets) {
      entries += (await ledgerRows(wallet.walletId)).length;
    }
    expect(entries).toBe(moving);
    await assertFinalConsistency(
      urls[1] as string,
      wallets.map((wallet) => wallet.walletId),
    );
  }, 120_000);
});
