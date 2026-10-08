import { expect } from 'bun:test';
import { appDb } from './db';

/**
 * Helpers HTTP dos testes de transação (integração e concorrência). Falam com a app real por `fetch`;
 * nada é mockado.
 */
export interface HttpResult<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

export interface SubmitBody {
  readonly transactionId: string;
  readonly status: string;
  readonly failureCode?: string;
  readonly balance?: MoneyJson;
  readonly idempotentReplay: boolean;
}

export interface ErrorJson {
  readonly error: { code: string; message: string; retryable: boolean; correlationId: string };
}

export interface TransactionInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyJson;
  referenceExternalTransactionId?: string;
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

export interface OpenedWallet {
  readonly walletId: string;
  readonly playerId: string;
}

let walletSeq = 0;

/** Abre uma wallet por HTTP (`POST /wallets`) com saldo inicial em BRL (ou na moeda pedida), para um player novo ou o informado. */
export async function openWallet(
  baseUrl: string,
  amount: string,
  currency = 'BRL',
  existingPlayerId?: string,
): Promise<OpenedWallet> {
  walletSeq += 1;
  const playerId = existingPlayerId ?? `player-${process.pid}-${Date.now()}-${walletSeq}`;
  const body = amount === '0.00' ? { playerId, currency } : { playerId, initialBalance: { amount, currency } };
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await parse<{ id: string }>(response);
  expect(parsed.status).toBe(201);
  return { walletId: parsed.body.id, playerId };
}

/** Operação de provedor com defaults (BET de 25.00 BRL na rodada `round-1`). */
export function operation(wallet: OpenedWallet, overrides: Partial<TransactionInput> = {}): TransactionInput {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${crypto.randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

/** Key recomendada pelo enunciado: `{providerId}:{externalTransactionId}`. */
export function defaultKey(input: TransactionInput): string {
  return `${input.providerId}:${input.externalTransactionId}`;
}

/**
 * `POST /wagering/transactions`. `key`: `undefined` = key padrão; `null` = sem header.
 * `body` pode ser qualquer coisa (testes de payload inválido).
 */
export async function submit<T = SubmitBody>(
  baseUrl: string,
  body: TransactionInput | unknown,
  key?: string | null,
  headers: Record<string, string> = {},
): Promise<HttpResult<T>> {
  const resolvedKey = key === undefined ? defaultKey(body as TransactionInput) : key;
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(resolvedKey === null ? {} : { 'idempotency-key': resolvedKey }),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return parse<T>(response);
}

/** Confere o corpo de erro uniforme. */
export function expectErrorCode(result: HttpResult, status: number, code: string): void {
  expect(result.status).toBe(status);
  const body = result.body as ErrorJson;
  expect(body.error).toMatchObject({ code, retryable: status === 503 });
  expect(body.error.correlationId.length).toBeGreaterThan(0);
}

/** Saldo gravado na wallet, como texto exato do `NUMERIC`. */
export async function walletBalance(walletId: string): Promise<string> {
  const [row] = await appDb()`select balance::text as balance from wallets where id = ${walletId}`;
  return (row as { balance: string }).balance;
}

export interface LedgerRow {
  readonly transaction_id: string;
  readonly direction: string;
  readonly amount: string;
  readonly balance_before: string;
  readonly balance_after: string;
  readonly wallet_version: number;
}

/** Lançamentos da wallet sem o de abertura, em ordem de versão. */
export async function ledgerRows(walletId: string): Promise<LedgerRow[]> {
  return (await appDb()`
    select e.transaction_id, e.direction, e.amount::text, e.balance_before::text, e.balance_after::text,
           e.wallet_version::int
      from wallet_ledger_entries e
      join wager_transactions t on t.id = e.transaction_id
     where e.wallet_id = ${walletId} and t.kind <> 'OPENING'
     order by e.wallet_version`) as LedgerRow[];
}

export interface OutboxRow {
  readonly event_type: string;
  readonly correlation_id: string;
  readonly payload: {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    data: Record<string, unknown>;
  };
}

/** Eventos da outbox de uma transação (pelo `data.transactionId`), em ordem de gravação. */
export async function outboxFor(transactionId: string): Promise<OutboxRow[]> {
  return (await appDb()`
    select event_type, correlation_id, payload
      from outbox_messages
     where payload->'data'->>'transactionId' = ${transactionId}
     order by occurred_at, id`) as OutboxRow[];
}
