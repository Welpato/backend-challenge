import { expect } from 'bun:test';
import { appDb } from '../../support/db';

export interface HttpResult<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly correlationId: string;
    readonly details?: readonly { path: string; message: string }[];
  };
}

export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

export interface WalletJson {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyJson;
  readonly version: number;
}

async function parse<T>(response: Response): Promise<HttpResult<T>> {
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: (text === '' ? undefined : JSON.parse(text)) as T,
  };
}

export async function getJson<T = unknown>(baseUrl: string, path: string): Promise<HttpResult<T>> {
  return parse<T>(await fetch(`${baseUrl}${path}`));
}

export async function postJson<T = unknown>(
  baseUrl: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult<T>> {
  return parse<T>(
    await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
  );
}

export function createWallet(baseUrl: string, body: unknown): Promise<HttpResult<WalletJson>> {
  return postJson<WalletJson>(baseUrl, '/wallets', body);
}

/** Confere o corpo de erro uniforme (ESPECIFICACAO.md §6). */
export function expectError(result: HttpResult, status: number, code: string): ErrorBody {
  expect(result.status).toBe(status);
  const body = result.body as ErrorBody;
  expect(body.error).toMatchObject({ code, retryable: status === 503 });
  expect(typeof body.error.message).toBe('string');
  expect(body.error.correlationId.length).toBeGreaterThan(0);
  return body;
}

export interface TableCounts {
  readonly wallets: number;
  readonly transactions: number;
  readonly ledger: number;
  readonly outbox: number;
}

export async function tableCounts(): Promise<TableCounts> {
  const [row] = await appDb()`
    select (select count(*) from wallets)::int as wallets,
           (select count(*) from wager_transactions)::int as transactions,
           (select count(*) from wallet_ledger_entries)::int as ledger,
           (select count(*) from outbox_messages)::int as outbox`;
  return row as TableCounts;
}

/** Valor do contador `name` no texto do `/metrics` (0 se ainda não existir amostra). */
export async function metricValue(baseUrl: string, name: string): Promise<number> {
  const text = await (await fetch(`${baseUrl}/metrics`)).text();
  const line = text
    .split('\n')
    .find((candidate) => candidate.startsWith(`${name}{`) || candidate.startsWith(`${name} `));
  return line === undefined ? 0 : Number(line.slice(line.lastIndexOf(' ') + 1));
}
