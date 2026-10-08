import { appDb } from '../../support/db';
import { openWallet, operation, submit } from '../../support/wagering-http';

/**
 * Gera eventos reais na outbox pelo fluxo de negócio (HTTP da API): cada wallet aberta com saldo gera 2 eventos
 * e cada BET processada mais 2. Devolve os ids (`eventId`) gravados.
 */
export async function produceEvents(apiBaseUrl: string, wallets: number, betsPerWallet: number): Promise<string[]> {
  const opened = await Promise.all(Array.from({ length: wallets }, () => openWallet(apiBaseUrl, '1000.00')));
  for (const wallet of opened) {
    await Promise.all(
      Array.from({ length: betsPerWallet }, () =>
        submit(apiBaseUrl, operation(wallet, { money: { amount: '1.00', currency: 'BRL' } })),
      ),
    );
  }
  return outboxIds();
}

export async function outboxIds(): Promise<string[]> {
  const rows = (await appDb()`select id from outbox_messages order by occurred_at, id`) as { id: string }[];
  return rows.map((row) => row.id);
}

export interface OutboxCounts {
  readonly total: number;
  readonly published: number;
  readonly pending: number;
  readonly maxAttempts: number;
}

export async function outboxCounts(): Promise<OutboxCounts> {
  const [row] = await appDb()`
    select count(*)::int as total,
           count(published_at)::int as published,
           (count(*) - count(published_at))::int as pending,
           coalesce(max(attempts), 0)::int as "maxAttempts"
      from outbox_messages`;
  return row as OutboxCounts;
}
