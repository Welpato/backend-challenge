import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { appDb, closeDb, truncateAll } from '../../support/db';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import {
  type ErrorJson,
  expectErrorCode,
  getJson,
  type OpenedWallet,
  openWallet,
  operation,
  submit,
} from '../../support/wagering-http';

let running: RunningTestApp;
let wallet: OpenedWallet;

beforeAll(async () => {
  running = await startTestApp({ INSTANCE_ID: 'it-wagering-http' });
});

afterAll(async () => {
  await running.close();
  await closeDb();
});

beforeEach(async () => {
  await truncateAll();
  wallet = await openWallet(running.baseUrl, '100.00');
});

async function providerTransactions(): Promise<number> {
  const [row] = await appDb()`select count(*)::int as n from wager_transactions where kind <> 'OPENING'`;
  return (row as { n: number }).n;
}

describe('POST /wagering/transactions — contract errors (400, nothing persisted)', () => {
  it('requires the Idempotency-Key header', async () => {
    expectErrorCode(await submit(running.baseUrl, operation(wallet), null), 400, 'MISSING_IDEMPOTENCY_KEY');
    expectErrorCode(await submit(running.baseUrl, operation(wallet), ''), 400, 'MISSING_IDEMPOTENCY_KEY');
    expect(await providerTransactions()).toBe(0);
  });

  it('limits the Idempotency-Key to 200 characters', async () => {
    const tooLong = await submit<ErrorJson & { error: { details: unknown } }>(
      running.baseUrl,
      operation(wallet),
      'k'.repeat(201),
    );
    expectErrorCode(tooLong, 400, 'VALIDATION_ERROR');
    expect(tooLong.body.error.details).toEqual([{ path: 'Idempotency-Key', message: expect.any(String) }]);
    expect((await submit(running.baseUrl, operation(wallet), 'k'.repeat(200))).status).toBe(201);
  });

  it('refuses OPENING with KIND_NOT_ALLOWED', async () => {
    expectErrorCode(await submit(running.baseUrl, operation(wallet, { kind: 'OPENING' })), 400, 'KIND_NOT_ALLOWED');
    expect(await providerTransactions()).toBe(0);
  });

  it.each([
    ['amount as number', { money: { amount: 25, currency: 'BRL' } }],
    ['amount without cents', { money: { amount: '25', currency: 'BRL' } }],
    ['negative amount', { money: { amount: '-1.00', currency: 'BRL' } }],
    ['lowercase currency', { money: { amount: '1.00', currency: 'brl' } }],
    ['unknown kind', { kind: 'JACKPOT' }],
    ['walletId not a UUID', { walletId: 'wallet-1' }],
    ['empty providerId', { providerId: '' }],
    ['BET of zero', { money: { amount: '0.00', currency: 'BRL' } }],
    ['REFUND without reference', { kind: 'REFUND' }],
    ['extra field', { extra: true }],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_label, overrides) => {
    const response = await submit(running.baseUrl, { ...operation(wallet), ...overrides }, 'some-key');
    expectErrorCode(response, 400, 'VALIDATION_ERROR');
    expect(await providerTransactions()).toBe(0);
  });

  it('rejects malformed JSON without echoing it', async () => {
    const response = await submit<ErrorJson>(running.baseUrl, '{"amount": "123.45"', 'some-key');
    expectErrorCode(response, 400, 'VALIDATION_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('123.45');
  });
});

describe('GET transaction endpoints', () => {
  it('returns a transaction by id and by provider + external id', async () => {
    const bet = operation(wallet);
    const created = await submit(running.baseUrl, bet);
    const id = created.body.transactionId;

    const byId = await getJson(running.baseUrl, `/wagering/transactions/${id}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual({
      id,
      providerId: 'provider-a',
      externalTransactionId: bet.externalTransactionId,
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      status: 'PROCESSED',
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      attempts: 0,
      createdAt: expect.any(String),
      processedAt: expect.any(String),
    });

    const byExternal = await getJson(
      running.baseUrl,
      `/providers/provider-a/wagering/transactions/${encodeURIComponent(bet.externalTransactionId)}`,
    );
    expect(byExternal.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
  });

  it('shows the failure code of a rejected transaction', async () => {
    const rejected = await submit(running.baseUrl, operation(wallet, { money: { amount: '100.01', currency: 'BRL' } }));
    const body = await getJson(running.baseUrl, `/wagering/transactions/${rejected.body.transactionId}`);
    expect(body.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
  });

  it('answers 404 for unknown transactions and 400 for a malformed id', async () => {
    expectErrorCode(
      await getJson(running.baseUrl, `/wagering/transactions/${crypto.randomUUID()}`),
      404,
      'TRANSACTION_NOT_FOUND',
    );
    expectErrorCode(
      await getJson(running.baseUrl, '/providers/provider-a/wagering/transactions/missing'),
      404,
      'TRANSACTION_NOT_FOUND',
    );
    expectErrorCode(await getJson(running.baseUrl, '/wagering/transactions/not-a-uuid'), 400, 'VALIDATION_ERROR');
  });
});
