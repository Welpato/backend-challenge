import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial (ESPECIFICACAO.md §4). O banco é a última linha de defesa: unicidade,
 * imutabilidade e não-negatividade ficam em constraints, índices e triggers, não só no código.
 *
 * Roda como `migrator` (dono do DDL). A aplicação conecta como `app`, que recebe só DML:
 * SELECT/INSERT/UPDATE nas tabelas mutáveis e apenas SELECT/INSERT no ledger. Nenhum DELETE.
 *
 * Códigos de erro (SQLSTATE) que a persistência (F07) pode mapear:
 * - `23505` unique_violation — idempotência, external id, reversão única, versão/transação no ledger;
 * - `23514` check_violation — CHECKs e a consistência wallet ↔ ledger (constraint `trg_wallet_ledger_consistency`);
 * - `P0001` raise_exception — imutabilidade (ledger append-only, transação finalizada, outbox, inbox);
 * - `42501` insufficient_privilege — o role `app` tentando UPDATE/DELETE fora dos grants.
 */
export class Migration0001_init extends Migration {
  override name = '0001_init';

  override up(): void {
    for (const statement of [...TABLES, ...INDEXES, ...FUNCTIONS, ...TRIGGERS, ...GRANTS]) {
      this.addSql(statement);
    }
  }

  override down(): void {
    // Os triggers caem junto com as tabelas; as funções ficam órfãs e são removidas depois.
    for (const statement of [
      'drop table if exists wallet_ledger_entries;',
      'drop table if exists outbox_messages;',
      'drop table if exists inbox_messages;',
      'drop table if exists wager_transactions;',
      'drop table if exists wallets;',
      'drop function if exists wallet_ledger_consistency();',
      'drop function if exists inbox_messages_no_delete();',
      'drop function if exists outbox_messages_immutable();',
      'drop function if exists wager_transactions_immutable();',
      'drop function if exists ledger_append_only();',
    ]) {
      this.addSql(statement);
    }
  }
}

const TABLES = [
  `create table wallets (
    id uuid primary key,
    player_id text not null,
    currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
    balance numeric(20, 2) not null check (balance >= 0),
    version bigint not null check (version >= 1),
    created_at timestamptz not null,
    updated_at timestamptz not null,
    constraint uq_wallets_player_currency unique (player_id, currency)
  );`,

  `create table wager_transactions (
    id uuid primary key,
    provider_id text not null,
    external_transaction_id text not null,
    idempotency_key text not null,
    payload_hash char(64) not null,
    wallet_id uuid not null references wallets (id),
    player_id text not null,
    round_id text not null,
    game_id text not null,
    kind text not null check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
    amount numeric(20, 2) not null check (amount >= 0),
    currency char(3) not null,
    reference_external_transaction_id text null,
    reference_transaction_id uuid null references wager_transactions (id),
    status text not null check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
    failure_code text null,
    balance_after_amount numeric(20, 2) null,
    balance_after_currency char(3) null,
    attempts int not null default 0,
    next_attempt_at timestamptz null,
    correlation_id text null,
    created_at timestamptz not null,
    processed_at timestamptz null,
    updated_at timestamptz not null,
    constraint uq_wager_transactions_idempotency_key unique (idempotency_key),
    constraint uq_wager_transactions_provider_external unique (provider_id, external_transaction_id),
    constraint ck_wager_transactions_reversal_reference
      check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
    constraint ck_wager_transactions_positive_amount
      check (kind not in ('BET', 'WIN', 'REFUND', 'ROLLBACK', 'OPENING') or amount > 0),
    constraint ck_wager_transactions_failure_code
      check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
    constraint ck_wager_transactions_pending_reference_schedule
      check (status <> 'PENDING_REFERENCE' or next_attempt_at is not null),
    constraint ck_wager_transactions_balance_after_pair
      check ((balance_after_amount is null) = (balance_after_currency is null))
  );`,

  `create table wallet_ledger_entries (
    id uuid primary key,
    wallet_id uuid not null references wallets (id),
    transaction_id uuid not null references wager_transactions (id),
    direction text not null check (direction in ('DEBIT', 'CREDIT')),
    amount numeric(20, 2) not null check (amount > 0),
    currency char(3) not null,
    balance_before numeric(20, 2) not null check (balance_before >= 0),
    balance_after numeric(20, 2) not null check (balance_after >= 0),
    wallet_version bigint not null,
    created_at timestamptz not null,
    constraint uq_ledger_transaction_wallet unique (transaction_id, wallet_id),
    constraint uq_ledger_wallet_version unique (wallet_id, wallet_version),
    constraint ck_ledger_arithmetic check (
      (direction = 'CREDIT' and balance_after = balance_before + amount)
      or (direction = 'DEBIT' and balance_after = balance_before - amount)
    )
  );`,

  `create table inbox_messages (
    consumer_name text not null,
    message_id text not null,
    payload_hash char(64) not null,
    received_at timestamptz not null,
    processed_at timestamptz null,
    primary key (consumer_name, message_id)
  );`,

  `create table outbox_messages (
    id uuid primary key,
    aggregate_id text not null,
    event_type text not null,
    event_version int not null,
    payload jsonb not null,
    correlation_id text null,
    occurred_at timestamptz not null,
    attempts int not null default 0,
    next_attempt_at timestamptz not null,
    published_at timestamptz null,
    last_error text null
  );`,
];

const INDEXES = [
  // Reversão única: no máximo uma REFUND/ROLLBACK PROCESSED por referência (impede REFUND + ROLLBACK
  // da mesma BET creditarem duas vezes).
  `create unique index ux_reversal_once on wager_transactions (reference_transaction_id)
    where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';`,
  `create index ix_pending_ref_due on wager_transactions (next_attempt_at) where status = 'PENDING_REFERENCE';`,
  'create index ix_ref_lookup on wager_transactions (provider_id, reference_external_transaction_id);',
  'create index ix_outbox_due on outbox_messages (next_attempt_at) where published_at is null;',
];

const FUNCTIONS = [
  // Ledger append-only: nem o dono da tabela consegue alterar ou apagar lançamentos.
  `create function ledger_append_only() returns trigger language plpgsql as $$
  begin
    raise exception 'ledger is append-only (% on wallet_ledger_entries)', tg_op;
  end;
  $$;`,

  // Transações: DELETE nunca; UPDATE nunca depois de status terminal; antes disso só as colunas que
  // as transições de estado mudam. Lista de permitidas (e não de proibidas): coluna nova nasce imutável.
  `create function wager_transactions_immutable() returns trigger language plpgsql as $$
  declare
    mutable_columns constant text[] := array[
      'status', 'reference_transaction_id', 'failure_code', 'processed_at', 'balance_after_amount',
      'balance_after_currency', 'attempts', 'next_attempt_at', 'updated_at'
    ];
    changed_columns text;
  begin
    if tg_op = 'DELETE' then
      raise exception 'wager transaction % cannot be deleted', old.id;
    end if;
    if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
      raise exception 'wager transaction % is final (%) and cannot be updated', old.id, old.status;
    end if;
    select string_agg(o.key, ', ' order by o.key) into changed_columns
      from jsonb_each(to_jsonb(old) - mutable_columns) as o
      where o.value is distinct from (to_jsonb(new) -> o.key);
    if changed_columns is not null then
      raise exception 'immutable columns of wager transaction % cannot change: %', old.id, changed_columns;
    end if;
    return new;
  end;
  $$;`,

  // Outbox: o evento em si é imutável; só o estado de publicação muda.
  `create function outbox_messages_immutable() returns trigger language plpgsql as $$
  declare
    mutable_columns constant text[] := array['attempts', 'next_attempt_at', 'published_at', 'last_error'];
    changed_columns text;
  begin
    select string_agg(o.key, ', ' order by o.key) into changed_columns
      from jsonb_each(to_jsonb(old) - mutable_columns) as o
      where o.value is distinct from (to_jsonb(new) -> o.key);
    if changed_columns is not null then
      raise exception 'immutable columns of outbox message % cannot change: %', old.id, changed_columns;
    end if;
    return new;
  end;
  $$;`,

  `create function inbox_messages_no_delete() returns trigger language plpgsql as $$
  begin
    raise exception 'inbox message (%, %) cannot be deleted', old.consumer_name, old.message_id;
  end;
  $$;`,

  // Wallet ↔ ledger, conferido no COMMIT: se a wallet tem lançamentos, saldo e versão batem com o
  // lançamento de maior versão; sem lançamentos, o saldo é zero. "Toda alteração de saldo tem
  // lançamento e vice-versa" passa a valer no schema.
  `create function wallet_ledger_consistency() returns trigger language plpgsql as $$
  declare
    target_wallet_id uuid;
    current_balance numeric(20, 2);
    current_version bigint;
    last_balance_after numeric(20, 2);
    last_wallet_version bigint;
  begin
    if tg_table_name = 'wallets' then
      target_wallet_id := new.id;
    else
      target_wallet_id := new.wallet_id;
    end if;

    select w.balance, w.version into current_balance, current_version
      from wallets as w where w.id = target_wallet_id;

    select e.balance_after, e.wallet_version into last_balance_after, last_wallet_version
      from wallet_ledger_entries as e
      where e.wallet_id = target_wallet_id
      order by e.wallet_version desc
      limit 1;

    if not found then
      if current_balance <> 0 then
        raise exception 'wallet % has balance % but no ledger entries', target_wallet_id, current_balance
          using errcode = 'check_violation', constraint = 'trg_wallet_ledger_consistency';
      end if;
    elsif current_balance <> last_balance_after or current_version <> last_wallet_version then
      raise exception 'wallet % (balance %, version %) does not match its last ledger entry (balance_after %, wallet_version %)',
        target_wallet_id, current_balance, current_version, last_balance_after, last_wallet_version
        using errcode = 'check_violation', constraint = 'trg_wallet_ledger_consistency';
    end if;
    return null;
  end;
  $$;`,
];

const TRIGGERS = [
  `create trigger trg_ledger_append_only before update or delete on wallet_ledger_entries
    for each row execute function ledger_append_only();`,
  `create trigger trg_tx_immutable before update or delete on wager_transactions
    for each row execute function wager_transactions_immutable();`,
  `create trigger trg_outbox_immutable before update on outbox_messages
    for each row execute function outbox_messages_immutable();`,
  `create trigger trg_inbox_no_delete before delete on inbox_messages
    for each row execute function inbox_messages_no_delete();`,
  `create constraint trigger trg_wallet_ledger_consistency after insert or update on wallets
    deferrable initially deferred
    for each row execute function wallet_ledger_consistency();`,
  `create constraint trigger trg_wallet_ledger_consistency after insert on wallet_ledger_entries
    deferrable initially deferred
    for each row execute function wallet_ledger_consistency();`,
];

const GRANTS = [
  'grant select, insert, update on wallets, wager_transactions, outbox_messages, inbox_messages to app;',
  'grant select, insert on wallet_ledger_entries to app;',
];
