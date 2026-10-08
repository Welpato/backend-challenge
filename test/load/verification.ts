import type { SentTracker } from './driver';
import { type LoadInfra, pgArray } from './infra';
import type { LoadWallet } from './operations';

/**
 * Fim de cada cenário: espera o sistema ficar quieto (fila de entrada vazia, outbox publicada, nenhuma
 * transação pendente) e confere as invariantes de **todas** as wallets do cenário — pela API de reconciliação
 * (F08) e direto no PostgreSQL (mesma conta do `assertLedgerInvariant` da F09, sobre `NUMERIC`).
 */

/** Amostra o lag da outbox a cada segundo (máximo, valor no fim da carga e pendentes). */
export class OutboxSampler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  maxLagSeconds = 0;
  maxPending = 0;
  lastLagSeconds = 0;

  constructor(private readonly infra: LoadInfra) {}

  start(): void {
    this.timer = setInterval(() => {
      this.inFlight = this.sample();
    }, 1000);
  }

  async sample(): Promise<void> {
    const status = await this.infra.outboxStatus().catch(() => undefined);
    if (status !== undefined) {
      this.lastLagSeconds = status.lagSeconds;
      this.maxLagSeconds = Math.max(this.maxLagSeconds, status.lagSeconds);
      this.maxPending = Math.max(this.maxPending, status.pending);
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.inFlight;
  }
}

export interface DrainResult {
  /** Do fim da carga até a fila de entrada esvaziar e toda mensagem enviada estar no banco (null: sem fila). */
  readonly queueDrainSeconds: number | null;
  /** Do fim da carga até a outbox ficar sem pendências. */
  readonly outboxDrainSeconds: number;
}

async function countRowsForKeys(infra: LoadInfra, keys: readonly string[]): Promise<number> {
  if (keys.length === 0) {
    return 0;
  }
  const rows = (await infra.db`
    select count(*)::int as n
      from wager_transactions
     where idempotency_key = any(${pgArray(keys)}::text[])
       and status in ('PROCESSED', 'REJECTED', 'FAILED')`) as { n: number }[];
  return rows[0]?.n ?? 0;
}

async function pendingFor(infra: LoadInfra, walletIds: string): Promise<number> {
  const rows = (await infra.db`
    select count(*)::int as n from wager_transactions
     where wallet_id = any(${walletIds}::uuid[]) and status in ('PENDING', 'PENDING_REFERENCE')`) as { n: number }[];
  return rows[0]?.n ?? 0;
}

export async function waitForQuiescence(
  infra: LoadInfra,
  wallets: readonly LoadWallet[],
  tracker: SentTracker,
  usesQueue: boolean,
  timeoutSeconds: number,
): Promise<DrainResult> {
  const started = performance.now();
  const deadline = started + timeoutSeconds * 1000;
  const walletIds = pgArray(wallets.map((wallet) => wallet.walletId));
  const sqsKeys = [...tracker.sqsSentAt.keys()];
  let queueDrainSeconds: number | null = usesQueue ? null : 0;
  let outboxDrainSeconds: number | null = null;
  let emptyReads = 0;
  while (performance.now() < deadline) {
    const elapsed = (performance.now() - started) / 1000;
    if (queueDrainSeconds === null) {
      const depth = await infra.queueDepth();
      emptyReads = depth === 0 ? emptyReads + 1 : 0;
      // Os atributos do SQS são aproximados: duas leituras zeradas + todas as mensagens com desfecho no banco.
      if (emptyReads >= 2 && (await countRowsForKeys(infra, sqsKeys)) === sqsKeys.length) {
        queueDrainSeconds = elapsed;
      }
    }
    if (outboxDrainSeconds === null && (await infra.outboxStatus()).pending === 0) {
      outboxDrainSeconds = elapsed;
    }
    if (queueDrainSeconds !== null && outboxDrainSeconds !== null && (await pendingFor(infra, walletIds)) === 0) {
      // A outbox pode ter recebido eventos depois da 1ª leitura zerada (fila ainda drenando): confere de novo.
      if ((await infra.outboxStatus()).pending === 0) {
        return { queueDrainSeconds, outboxDrainSeconds };
      }
      outboxDrainSeconds = null;
    }
    await Bun.sleep(250);
  }
  const settled = await countRowsForKeys(infra, sqsKeys);
  const missing =
    settled === sqsKeys.length
      ? []
      : ((await infra.db`
          select k from unnest(${pgArray(sqsKeys)}::text[]) as k
           where not exists (select 1 from wager_transactions t where t.idempotency_key = k
                               and t.status in ('PROCESSED', 'REJECTED', 'FAILED'))
           limit 5`) as { k: string }[]);
  throw new Error(
    `system did not quiesce within ${timeoutSeconds}s: queue depth ${await infra.queueDepth()}, ` +
      `queue messages settled ${settled}/${sqsKeys.length}, outbox pending ${(await infra.outboxStatus()).pending}, ` +
      `pending transactions ${await pendingFor(infra, walletIds)}` +
      (missing.length === 0 ? '' : `, unsettled queue keys (sample): ${missing.map((row) => row.k).join(' ')}`),
  );
}

export interface VerificationResult {
  readonly wallets: number;
  readonly apiConsistent: number;
  readonly sqlViolations: number;
  readonly sentKeys: number;
  readonly definitiveKeys: number;
  readonly transactionRows: number;
  readonly rowsWithUnknownKey: number;
  readonly processedBalanceOps: number;
  readonly ledgerEntries: number;
  readonly pending: number;
  readonly dlqNew: number;
  readonly consistent: boolean;
}

interface CountsRow {
  readonly tx_rows: number;
  readonly processed_affecting: number;
  readonly ledger_entries: number;
  readonly violations: number;
}

export async function verifyScenario(
  infra: LoadInfra,
  apiUrl: string,
  wallets: readonly LoadWallet[],
  tracker: SentTracker,
  dlqBaseline: number,
): Promise<VerificationResult> {
  const walletIds = pgArray(wallets.map((wallet) => wallet.walletId));

  let apiConsistent = 0;
  let next = 0;
  const reconcile = async (): Promise<void> => {
    while (next < wallets.length) {
      const wallet = wallets[next] as LoadWallet;
      next += 1;
      const response = await fetch(`${apiUrl}/wallets/${wallet.walletId}/reconciliation`, { method: 'POST' });
      const report = (await response.json().catch(() => ({}))) as { consistent?: boolean };
      if (response.status === 200 && report.consistent === true) {
        apiConsistent += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: 20 }, reconcile));

  // Mesmas regras do assertLedgerInvariant: saldo = Σ ledger, cadeia encadeada, versões contíguas desde 1 (ou 2,
  // wallet aberta com 0.00) até wallet.version,
  // aritmética de cada lançamento e nada negativo. Conta as wallets que violam qualquer uma.
  const counts = (await infra.db`
    with chain as (
      select e.*, lag(e.balance_after) over (partition by e.wallet_id order by e.wallet_version) as previous_after
        from wallet_ledger_entries e where e.wallet_id = any(${walletIds}::uuid[])
    ), per_wallet as (
      select w.id,
             w.balance = coalesce(sum(case c.direction when 'CREDIT' then c.amount else -c.amount end), 0)
             and count(*) filter (where c.balance_before <> coalesce(c.previous_after, 0)) = 0
             and count(*) filter (where (c.direction = 'CREDIT' and c.balance_after <> c.balance_before + c.amount)
                                     or (c.direction = 'DEBIT' and c.balance_after <> c.balance_before - c.amount)) = 0
             and count(*) filter (where c.balance_after < 0 or c.balance_before < 0) = 0
             and w.balance >= 0
             and (count(c.id) = 0 and w.balance = 0
                  or min(c.wallet_version) in (1, 2) and max(c.wallet_version) - min(c.wallet_version) + 1 = count(c.id)
                     and max(c.wallet_version) = w.version
                     and (array_agg(c.balance_after order by c.wallet_version desc))[1] = w.balance) as ok
        from wallets w left join chain c on c.wallet_id = w.id
       where w.id = any(${walletIds}::uuid[])
       group by w.id, w.balance, w.version
    )
    select
      (select count(*)::int from wager_transactions
        where wallet_id = any(${walletIds}::uuid[]) and kind <> 'OPENING') as tx_rows,
      (select count(*)::int from wager_transactions
        where wallet_id = any(${walletIds}::uuid[]) and status = 'PROCESSED' and kind <> 'LOSS') as processed_affecting,
      (select count(*)::int from wallet_ledger_entries where wallet_id = any(${walletIds}::uuid[])) as ledger_entries,
      (select count(*)::int from per_wallet where not ok) + ${wallets.length}
        - (select count(*)::int from per_wallet) as violations`) as CountsRow[];
  const row = counts[0] as CountsRow;

  const sentKeys = [...tracker.sentKeys];
  const known = (await infra.db`
    select count(*)::int as n from wager_transactions
     where wallet_id = any(${walletIds}::uuid[]) and kind <> 'OPENING'
       and idempotency_key = any(${pgArray(sentKeys)}::text[])`) as { n: number }[];
  const rowsWithUnknownKey = row.tx_rows - (known[0]?.n ?? 0);
  const pending = await pendingFor(infra, walletIds);
  // Só o que chegou à DLQ durante o cenário (a fila pode ter sobras de testes manuais anteriores).
  const dlqNew = (await infra.queueDepth(infra.dlqUrl)) - dlqBaseline;

  const consistent =
    apiConsistent === wallets.length &&
    row.violations === 0 &&
    rowsWithUnknownKey === 0 &&
    // Uma transação por key enviada: nem duplicada (≤ enviadas) nem perdida (≥ respostas definitivas + fila).
    row.tx_rows <= tracker.sentKeys.size &&
    row.tx_rows >= tracker.definitiveKeys.size + tracker.sqsSentAt.size &&
    // Um lançamento por transação que move saldo (OPENING, BET, WIN, REFUND processados).
    row.processed_affecting === row.ledger_entries &&
    pending === 0 &&
    dlqNew <= 0;

  return {
    wallets: wallets.length,
    apiConsistent,
    sqlViolations: row.violations,
    sentKeys: tracker.sentKeys.size,
    definitiveKeys: tracker.definitiveKeys.size + tracker.sqsSentAt.size,
    transactionRows: row.tx_rows,
    rowsWithUnknownKey,
    processedBalanceOps: row.processed_affecting,
    ledgerEntries: row.ledger_entries,
    pending,
    dlqNew: Math.max(0, dlqNew),
    consistent,
  };
}

/** Latência ponta a ponta das mensagens da fila: `processed_at` (banco) − instante do envio (cliente). */
export async function queueEndToEndMs(infra: LoadInfra, tracker: SentTracker): Promise<number[]> {
  const keys = [...tracker.sqsSentAt.keys()];
  if (keys.length === 0) {
    return [];
  }
  const rows = (await infra.db`
    select idempotency_key as key, (extract(epoch from processed_at) * 1000)::float8 as processed_ms
      from wager_transactions
     where idempotency_key = any(${pgArray(keys)}::text[]) and processed_at is not null`) as {
    key: string;
    processed_ms: number;
  }[];
  return rows.map((row) => Math.max(0, row.processed_ms - (tracker.sqsSentAt.get(row.key) ?? row.processed_ms)));
}
