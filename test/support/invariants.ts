import { expect } from 'bun:test';
import { appDb } from './db';

interface InvariantRow {
  readonly wallet_id: string;
  readonly balance: string;
  readonly calculated: string;
  readonly version: number;
  readonly entries: number;
  readonly min_version: number | null;
  readonly max_version: number | null;
  readonly last_balance_after: string | null;
  readonly broken_links: number;
  readonly bad_arithmetic: number;
  readonly negative: number;
}

/**
 * Invariante financeira de cada wallet (ESPECIFICACAO.md §11 — todo teste de integração/concorrência
 * termina com ela), calculada no próprio PostgreSQL sobre `NUMERIC` (sem `number`):
 * - `wallet.balance == Σ créditos − Σ débitos` do ledger;
 * - versões do ledger contíguas `1..n` e a última igual a `wallet.version` (sem lançamentos: saldo 0);
 * - `balance_before` de cada lançamento = `balance_after` do anterior (0 no primeiro), aritmética certa;
 * - nenhum saldo negativo;
 * - e, se `baseUrl` for informado, a reconciliação da API responde `consistent: true`.
 */
export async function assertLedgerInvariant(
  walletIds: readonly string[],
  options: { baseUrl?: string } = {},
): Promise<void> {
  expect(walletIds.length).toBeGreaterThan(0);
  const rows = (await appDb()`
    with chain as (
      select e.*,
             lag(e.balance_after) over (partition by e.wallet_id order by e.wallet_version) as previous_after
        from wallet_ledger_entries e
       where e.wallet_id = any(${`{${walletIds.join(',')}}`}::uuid[])
    )
    select w.id as wallet_id,
           w.balance::text as balance,
           coalesce(sum(case c.direction when 'CREDIT' then c.amount else -c.amount end), 0)::numeric(20,2)::text
             as calculated,
           w.version::int as version,
           count(c.id)::int as entries,
           min(c.wallet_version)::int as min_version,
           max(c.wallet_version)::int as max_version,
           (array_agg(c.balance_after::text order by c.wallet_version desc))[1] as last_balance_after,
           count(*) filter (where c.balance_before <> coalesce(c.previous_after, 0))::int as broken_links,
           count(*) filter (
             where (c.direction = 'CREDIT' and c.balance_after <> c.balance_before + c.amount)
                or (c.direction = 'DEBIT' and c.balance_after <> c.balance_before - c.amount)
           )::int as bad_arithmetic,
           count(*) filter (where c.balance_after < 0 or c.balance_before < 0)::int
             + (case when w.balance < 0 then 1 else 0 end) as negative
      from wallets w
      left join chain c on c.wallet_id = w.id
     where w.id = any(${`{${walletIds.join(',')}}`}::uuid[])
     group by w.id, w.balance, w.version`) as InvariantRow[];

  expect(rows).toHaveLength(new Set(walletIds).size);
  for (const row of rows) {
    const context = `wallet ${row.wallet_id}`;
    expect(row.calculated, context).toBe(row.balance);
    expect(row.broken_links, context).toBe(0);
    expect(row.bad_arithmetic, context).toBe(0);
    expect(row.negative, context).toBe(0);
    if (row.entries === 0) {
      expect(row.balance, context).toBe('0.00');
    } else {
      expect(row.min_version, context).toBe(1);
      expect(row.max_version, context).toBe(row.entries);
      expect(row.max_version, context).toBe(row.version);
      expect(row.last_balance_after, context).toBe(row.balance);
    }
  }

  if (options.baseUrl !== undefined) {
    for (const walletId of walletIds) {
      const response = await fetch(`${options.baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' });
      expect(response.status).toBe(200);
      const report = (await response.json()) as { consistent: boolean };
      expect(report.consistent, `reconciliation of wallet ${walletId}`).toBe(true);
    }
  }
}
