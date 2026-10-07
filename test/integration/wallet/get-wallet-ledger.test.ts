import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Money } from '@/shared/money/money';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { encodeLedgerCursor } from '@/wallet/application/ledger-cursor';
import { closeDb, truncateAll } from '../../support/db';
import { openPersistence, type Persistence } from '../../support/persistence';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import { AT, betFor } from '../persistence/persistence-fixtures';
import { createWallet, expectError, getJson, type MoneyJson, type WalletJson } from './wallet-test-kit';

interface LedgerEntryJson {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly money: MoneyJson;
  readonly balanceBefore: MoneyJson;
  readonly balanceAfter: MoneyJson;
  readonly walletVersion: number;
  readonly createdAt: string;
}

interface LedgerPageJson {
  readonly items: readonly LedgerEntryJson[];
  readonly nextCursor: string | null;
}

let running: RunningTestApp;
let db: Persistence;

beforeAll(async () => {
  running = await startTestApp({ INSTANCE_ID: 'it-wallet-read' });
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

/**
 * Acrescenta `count` lançamentos à wallet pelos repositórios (como o use case de transação fará): cada um com
 * a sua transação, alternando débito de 1.00 e crédito de 0.50, numa única unidade de trabalho.
 */
async function appendEntries(walletId: string, count: number): Promise<void> {
  await db.uow.run(async () => {
    const wallet = await db.wallets.findByIdForUpdate(walletId);
    if (wallet === undefined) {
      throw new Error('wallet not found');
    }
    const initialVersion = wallet.version;
    for (let i = 0; i < count; i += 1) {
      const debit = i % 2 === 0;
      const money = debit ? brl('1.00') : brl('0.50');
      const tx = betFor(wallet, { kind: debit ? WagerTransactionKind.Bet : WagerTransactionKind.Win, money });
      await db.transactions.insertIfAbsent(tx);
      const entry = debit ? wallet.debit(tx.id, money, AT) : wallet.credit(tx.id, money, AT);
      await db.ledger.append(entry);
    }
    await db.wallets.updateBalance(wallet, initialVersion);
  });
}

async function openWallet(amount = '1000.00'): Promise<WalletJson> {
  const response = await createWallet(running.baseUrl, {
    playerId: `player-${crypto.randomUUID()}`,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(response.status).toBe(201);
  return response.body;
}

describe('GET /wallets/:walletId', () => {
  it('returns the wallet in the challenge format', async () => {
    const created = await openWallet('1000.00');
    const response = await getJson<WalletJson>(running.baseUrl, `/wallets/${created.id}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(created);
  });

  it('reflects later balance changes and version', async () => {
    const created = await openWallet('1000.00');
    await appendEntries(created.id, 3);
    const response = await getJson<WalletJson>(running.baseUrl, `/wallets/${created.id}`);
    expect(response.body).toMatchObject({ balance: { amount: '998.50', currency: 'BRL' }, version: 4 });
  });

  it('returns 404 WALLET_NOT_FOUND for an unknown wallet', async () => {
    expectError(await getJson(running.baseUrl, `/wallets/${crypto.randomUUID()}`), 404, 'WALLET_NOT_FOUND');
  });

  it('returns 400 VALIDATION_ERROR for a non-UUID id', async () => {
    const error = expectError(await getJson(running.baseUrl, '/wallets/not-a-uuid'), 400, 'VALIDATION_ERROR');
    expect(error.error.details).toEqual([{ path: 'walletId', message: 'must be a UUID' }]);
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  it('pages 120 entries 50 at a time, in ascending version order, without repeating or skipping', async () => {
    const wallet = await openWallet('1000.00');
    await appendEntries(wallet.id, 119);

    const pages: LedgerPageJson[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '' : `?cursor=${cursor}`;
      const response = await getJson<LedgerPageJson>(running.baseUrl, `/wallets/${wallet.id}/ledger${query}`);
      expect(response.status).toBe(200);
      pages.push(response.body);
      cursor = response.body.nextCursor;
    } while (cursor !== null && pages.length < 10);

    expect(pages.map((page) => page.items.length)).toEqual([50, 50, 20]);
    expect(pages.at(-1)?.nextCursor).toBeNull();
    const items = pages.flatMap((page) => page.items);
    expect(items.map((item) => item.walletVersion)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(new Set(items.map((item) => item.id)).size).toBe(120);
    expect(items.every((item) => item.walletId === wallet.id)).toBe(true);
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i]?.balanceBefore).toEqual(items[i - 1]?.balanceAfter as MoneyJson);
    }
    expect(items[0]).toEqual({
      id: expect.any(String),
      walletId: wallet.id,
      transactionId: expect.any(String),
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(items.at(-1)?.balanceAfter).toEqual({ amount: '969.50', currency: 'BRL' }); // 1000 − 60 × 1.00 + 59 × 0.50
  });

  it('honours limit (up to 200) and keeps the cursor stable while new entries arrive', async () => {
    const wallet = await openWallet('1000.00');
    await appendEntries(wallet.id, 9);

    const first = await getJson<LedgerPageJson>(running.baseUrl, `/wallets/${wallet.id}/ledger?limit=4`);
    expect(first.body.items.map((item) => item.walletVersion)).toEqual([1, 2, 3, 4]);
    expect(first.body.nextCursor).toBe(encodeLedgerCursor(4));

    await appendEntries(wallet.id, 2);
    const second = await getJson<LedgerPageJson>(
      running.baseUrl,
      `/wallets/${wallet.id}/ledger?limit=200&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items.map((item) => item.walletVersion)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(second.body.nextCursor).toBeNull();
  });

  it('does not return a trailing empty page when the total is a multiple of the limit', async () => {
    const wallet = await openWallet('1000.00');
    await appendEntries(wallet.id, 3);
    const first = await getJson<LedgerPageJson>(running.baseUrl, `/wallets/${wallet.id}/ledger?limit=2`);
    const second = await getJson<LedgerPageJson>(
      running.baseUrl,
      `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
  });

  it('returns an empty page for a wallet opened with 0.00', async () => {
    const created = await createWallet(running.baseUrl, { playerId: 'zero', currency: 'BRL' });
    const response = await getJson<LedgerPageJson>(running.baseUrl, `/wallets/${created.body.id}/ledger`);
    expect(response.body).toEqual({ items: [], nextCursor: null });
  });

  it('returns 404 WALLET_NOT_FOUND for an unknown wallet', async () => {
    expectError(await getJson(running.baseUrl, `/wallets/${crypto.randomUUID()}/ledger`), 404, 'WALLET_NOT_FOUND');
  });

  const invalidCursors: readonly [string, string][] = [
    ['garbage', 'not-a-cursor!'],
    ['base64url of something else', Buffer.from('hello').toString('base64url')],
    ['version zero', Buffer.from('{"v":0}').toString('base64url')],
    ['negative version', Buffer.from('{"v":-3}').toString('base64url')],
    ['fractional version', Buffer.from('{"v":1.5}').toString('base64url')],
    ['string version', Buffer.from('{"v":"3"}').toString('base64url')],
    ['extra keys', Buffer.from('{"v":3,"w":1}').toString('base64url')],
    ['padded base64', `${encodeLedgerCursor(3)}=`],
    ['empty', ''],
  ];

  for (const [name, cursor] of invalidCursors) {
    it(`rejects an invalid cursor (${name}) with 400`, async () => {
      const wallet = await openWallet('1.00');
      const error = expectError(
        await getJson(running.baseUrl, `/wallets/${wallet.id}/ledger?cursor=${encodeURIComponent(cursor)}`),
        400,
        'VALIDATION_ERROR',
      );
      expect(error.error.details?.map((detail) => detail.path)).toEqual(['cursor']);
    });
  }

  for (const limit of ['0', '201', 'abc', '-1', '1.5', '10&limit=20']) {
    it(`rejects limit=${limit} with 400`, async () => {
      const wallet = await openWallet('1.00');
      const error = expectError(
        await getJson(running.baseUrl, `/wallets/${wallet.id}/ledger?limit=${limit}`),
        400,
        'VALIDATION_ERROR',
      );
      expect(error.error.details?.map((detail) => detail.path)).toEqual(['limit']);
    });
  }
});
