import { expect } from 'bun:test';
import { appDb } from '../../support/db';
import { assertLedgerInvariant } from '../../support/invariants';
import {
  createIsolatedQueue,
  createWagerQueues,
  deleteQueue,
  deleteWagerQueues,
  drainQueue,
  envelopeOf,
  type IsolatedQueue,
  queueDepth,
  sendEnvelope,
  type WagerQueues,
  wagerEnvelope,
} from '../../support/sqs';
import { waitFor } from '../../support/subprocess';
import { type OpenedWallet, openWallet, type TransactionInput } from '../../support/wagering-http';

/**
 * Ambiente comum das instâncias da suíte multi-instância: workers com intervalos curtos (o teste espera por
 * condição, não por tempo) e long-poll de 1 s (o SIGTERM não espera 20 s).
 */
export const FAST_WORKERS_ENV: Readonly<Record<string, string>> = Object.freeze({
  SQS_WAIT_TIME_SECONDS: '1',
  OUTBOX_POLL_INTERVAL_MS: '50',
  REPROCESSOR_INTERVAL_MS: '100',
  PENDING_REFERENCE_BACKOFF_BASE_MS: '100',
  PENDING_REFERENCE_BACKOFF_MAX_MS: '1000',
  SQS_RETRY_BACKOFF_BASE_MS: '1000',
  SQS_RETRY_BACKOFF_MAX_MS: '2000',
});

/** Abre `count` wallets com o mesmo saldo, distribuindo a criação entre as APIs. */
export async function openWallets(apiUrls: readonly string[], count: number, amount: string): Promise<OpenedWallet[]> {
  return Promise.all(
    Array.from({ length: count }, (_, index) => openWallet(apiUrls[index % apiUrls.length] as string, amount)),
  );
}

/**
 * Fechamento obrigatório de todo cenário: invariante do ledger calculada no PostgreSQL **e** a reconciliação
 * pela API (`consistent: true`), chamada numa instância de API qualquer.
 */
export async function assertFinalConsistency(apiUrl: string, walletIds: readonly string[]): Promise<void> {
  await assertLedgerInvariant(walletIds, { baseUrl: apiUrl });
}

export async function statusCounts(walletIds?: readonly string[]): Promise<Record<string, number>> {
  const rows = (
    walletIds === undefined
      ? await appDb()`
          select status, count(*)::int as n from wager_transactions where kind <> 'OPENING' group by status`
      : await appDb()`
          select status, count(*)::int as n from wager_transactions
           where kind <> 'OPENING' and wallet_id = any(${`{${walletIds.join(',')}}`}::uuid[])
           group by status`
  ) as { status: string; n: number }[];
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

export async function outboxPending(): Promise<number> {
  const [row] = await appDb()`select count(*)::int as n from outbox_messages where published_at is null`;
  return (row as { n: number }).n;
}

export async function outboxIds(): Promise<string[]> {
  const rows = (await appDb()`select id from outbox_messages order by id`) as { id: string }[];
  return rows.map((row) => row.id);
}

/** Espera a outbox zerar (todos os eventos publicados). */
export async function waitForOutboxDrained(timeoutMs = 60_000): Promise<void> {
  await waitFor(async () => (await outboxPending()) === 0, timeoutMs, 'outbox fully published', 200);
}

/** Espera a fila de entrada ficar vazia (tudo com ack). */
export async function waitForQueueEmpty(queue: IsolatedQueue, timeoutMs = 60_000): Promise<void> {
  await waitFor(async () => (await queueDepth(queue)) === 0, timeoutMs, `${queue.name} empty`, 200);
}

/**
 * Lê a fila de eventos inteira e confere que **todo** evento da outbox foi publicado (o conjunto de `eventId`
 * da fila é exatamente o da outbox; duplicatas, se houver, têm o mesmo `eventId`).
 */
export async function expectAllEventsPublished(eventsQueue: IsolatedQueue): Promise<void> {
  const delivered = await drainQueue(eventsQueue);
  const deliveredIds = new Set(delivered.map((message) => envelopeOf(message).eventId));
  expect([...deliveredIds].sort()).toEqual(await outboxIds());
}

/** Soma de uma métrica em várias instâncias. */
export async function sumMetric(urls: readonly string[], read: (url: string) => Promise<number>): Promise<number> {
  const values = await Promise.all(urls.map((url) => read(url)));
  return values.reduce((total, value) => total + value, 0);
}

/** `cents` inteiros → `"12.34"` (montagem de valores nos geradores; nunca usado para somar dinheiro). */
export function amountOf(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Filas isoladas de um cenário: entrada + DLQ (com redrive) e a fila de eventos da outbox. */
export interface ScenarioQueues {
  readonly wager: WagerQueues;
  readonly events: IsolatedQueue;
  /** Ambiente para todas as instâncias usarem estas filas. */
  readonly env: Record<string, string>;
  delete(): Promise<void>;
}

/**
 * Visibilidade curta: mensagens em voo num processo morto por SIGKILL voltam em segundos (no lugar dos 30 s
 * da fila real), sem mudar a semântica.
 */
export async function createScenarioQueues(prefix: string, visibilityTimeoutSeconds = 3): Promise<ScenarioQueues> {
  const wager = await createWagerQueues(prefix, { visibilityTimeoutSeconds });
  const events = await createIsolatedQueue(`${prefix}-events`);
  return {
    wager,
    events,
    env: { ...wager.env, SQS_EVENTS_QUEUE_NAME: events.name },
    async delete() {
      await Promise.all([deleteWagerQueues(wager), deleteQueue(events)]);
    },
  };
}

/** Publica a operação na fila de entrada (envelope de DESAFIO.md §10, key padrão `{provider}:{external}`). */
export async function sendOperation(queue: IsolatedQueue, input: TransactionInput, messageId?: string): Promise<void> {
  await sendEnvelope(
    queue,
    wagerEnvelope({
      ...(messageId === undefined ? {} : { messageId }),
      data: { ...input, idempotencyKey: `${input.providerId}:${input.externalTransactionId}` },
    }),
  );
}

/** Espera todas as transações de provedor saírem de `PENDING_REFERENCE` e chegarem a `expectedTotal`. */
export async function waitForSettled(expectedTotal: number, timeoutMs = 60_000): Promise<Record<string, number>> {
  let counts: Record<string, number> = {};
  await waitFor(
    async () => {
      counts = await statusCounts();
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      return total === expectedTotal && (counts.PENDING_REFERENCE ?? 0) === 0;
    },
    timeoutMs,
    `${expectedTotal} transactions settled`,
    200,
  ).catch((error: unknown) => {
    throw new Error(`${(error as Error).message}; last counts ${JSON.stringify(counts)}`);
  });
  return counts;
}

/** Saldo de todas as wallets pedidas (texto exato do NUMERIC). */
export async function balancesOf(walletIds: readonly string[]): Promise<string[]> {
  const rows = (await appDb()`
    select balance::text as balance from wallets where id = any(${`{${walletIds.join(',')}}`}::uuid[])`) as {
    balance: string;
  }[];
  return rows.map((row) => row.balance);
}
