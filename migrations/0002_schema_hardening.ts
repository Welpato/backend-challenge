import { Migration } from '@mikro-orm/migrations';

/**
 * Endurecimento do schema (pós-auditoria F17): garantias da §6 que até aqui só o código aplicava passam a valer
 * também no banco.
 *
 * 1. `trg_wallets_immutable` (BEFORE INSERT/UPDATE/DELETE em `wallets`):
 *    - `id`, `player_id`, `currency` e `created_at` nunca mudam (lista de colunas **permitidas**: `balance`,
 *      `version`, `updated_at` — coluna nova nasce imutável, como nas outras tabelas);
 *    - a wallet nasce na versão 1, e a versão sobe **exatamente 1** quando o saldo muda e não muda quando o saldo
 *      fica igual (§6.2);
 *    - DELETE nunca (o `app` já não tem o privilégio; o trigger vale até para o dono).
 * 2. `trg_ledger_entry_integrity` (constraint trigger DEFERRABLE INITIALLY DEFERRED, no COMMIT — depois das
 *    CHECKs de linha e de a transação de domínio ter recebido o status final na mesma transação SQL):
 *    - o lançamento é da mesma wallet da transação, com o mesmo valor e moeda, e na moeda da wallet;
 *    - só transação `PROCESSED` gera lançamento, nunca `LOSS` (§6.4);
 *    - direção coerente com o kind: BET → DEBIT; OPENING/WIN/REFUND → CREDIT; ROLLBACK → o inverso do
 *      lançamento da referência;
 *    - cadeia contígua: o anterior da wallet tem a versão imediatamente abaixo e `balance_after` =
 *      `balance_before` deste; o primeiro tem versão 1 (aberta com saldo) ou 2 (aberta com 0.00) e parte de 0.
 * 3. `trg_inbox_immutable` (BEFORE UPDATE em `inbox_messages`): só `processed_at` muda, e só de NULL para um
 *    instante (uma mensagem processada não volta a ficar pendente; o hash não é trocado).
 *
 * Erros: imutabilidade → `P0001` (como os triggers da 0001); integridade do lançamento → `23514`
 * `check_violation` com `constraint = 'trg_ledger_entry_integrity'` (a persistência classifica como
 * `CheckViolationError`, como a consistência wallet ↔ ledger).
 */
export class Migration0002_schema_hardening extends Migration {
  override name = '0002_schema_hardening';

  override up(): void {
    for (const statement of [...FUNCTIONS, ...TRIGGERS]) {
      this.addSql(statement);
    }
  }

  override down(): void {
    for (const statement of [
      'drop trigger if exists trg_inbox_immutable on inbox_messages;',
      'drop trigger if exists trg_ledger_entry_integrity on wallet_ledger_entries;',
      'drop trigger if exists trg_wallets_immutable on wallets;',
      'drop function if exists inbox_messages_immutable();',
      'drop function if exists ledger_entry_integrity();',
      'drop function if exists wallets_immutable();',
    ]) {
      this.addSql(statement);
    }
  }
}

const FUNCTIONS = [
  `create function wallets_immutable() returns trigger language plpgsql as $$
  declare
    mutable_columns constant text[] := array['balance', 'version', 'updated_at'];
    changed_columns text;
  begin
    if tg_op = 'DELETE' then
      raise exception 'wallet % cannot be deleted', old.id;
    end if;
    if tg_op = 'INSERT' then
      -- Versão < 1 fica para o CHECK da coluna (mensagem e SQLSTATE próprios).
      if new.version > 1 then
        raise exception 'wallet % must be created at version 1 (got %)', new.id, new.version;
      end if;
      return new;
    end if;
    select string_agg(o.key, ', ' order by o.key) into changed_columns
      from jsonb_each(to_jsonb(old) - mutable_columns) as o
      where o.value is distinct from (to_jsonb(new) -> o.key);
    if changed_columns is not null then
      raise exception 'immutable columns of wallet % cannot change: %', old.id, changed_columns;
    end if;
    if new.balance is distinct from old.balance then
      if new.version is distinct from old.version + 1 then
        raise exception 'wallet % balance changed: version must go from % to % (got %)',
          old.id, old.version, old.version + 1, new.version;
      end if;
    elsif new.version is distinct from old.version then
      raise exception 'wallet % version changed (% -> %) without a balance change', old.id, old.version, new.version;
    end if;
    return new;
  end;
  $$;`,

  `create function ledger_entry_integrity() returns trigger language plpgsql as $$
  declare
    tx record;
    wallet_currency char(3);
    reference_direction text;
    previous record;
    problem text;
  begin
    select t.wallet_id, t.kind, t.status, t.amount, t.currency, t.reference_transaction_id into tx
      from wager_transactions as t where t.id = new.transaction_id;
    select w.currency into wallet_currency from wallets as w where w.id = new.wallet_id;

    if tx.wallet_id is distinct from new.wallet_id then
      problem := 'belongs to another wallet than its transaction';
    elsif tx.status <> 'PROCESSED' then
      problem := format('references a %s transaction (only PROCESSED transactions move the balance)', tx.status);
    elsif tx.kind = 'LOSS' then
      problem := 'references a LOSS (no balance effect)';
    elsif new.amount <> tx.amount or new.currency <> tx.currency then
      problem := 'amount/currency differ from its transaction';
    elsif new.currency <> wallet_currency then
      problem := 'is not in the wallet currency';
    elsif tx.kind = 'BET' and new.direction <> 'DEBIT' then
      problem := 'of a BET must be a DEBIT';
    elsif tx.kind in ('OPENING', 'WIN', 'REFUND') and new.direction <> 'CREDIT' then
      problem := format('of a %s must be a CREDIT', tx.kind);
    elsif tx.kind = 'ROLLBACK' then
      select e.direction into reference_direction
        from wallet_ledger_entries as e
        where e.transaction_id = tx.reference_transaction_id and e.wallet_id = new.wallet_id;
      if reference_direction is null or reference_direction = new.direction then
        problem := 'of a ROLLBACK must invert the entry of its reference';
      end if;
    end if;

    if problem is null then
      select e.wallet_version, e.balance_after into previous
        from wallet_ledger_entries as e
        where e.wallet_id = new.wallet_id and e.wallet_version < new.wallet_version
        order by e.wallet_version desc
        limit 1;
      if not found then
        if new.wallet_version not in (1, 2) or new.balance_before <> 0 then
          problem := 'is the first of its wallet: it must be version 1 or 2 and start from 0.00';
        end if;
      elsif new.wallet_version <> previous.wallet_version + 1 or new.balance_before <> previous.balance_after then
        problem := format('breaks the chain (previous entry: version %s, balance_after %s)',
          previous.wallet_version, previous.balance_after);
      end if;
    end if;

    if problem is not null then
      raise exception 'ledger entry % (wallet %, version %) %', new.id, new.wallet_id, new.wallet_version, problem
        using errcode = 'check_violation', constraint = 'trg_ledger_entry_integrity';
    end if;
    return null;
  end;
  $$;`,

  `create function inbox_messages_immutable() returns trigger language plpgsql as $$
  declare
    changed_columns text;
  begin
    select string_agg(o.key, ', ' order by o.key) into changed_columns
      from jsonb_each(to_jsonb(old) - 'processed_at') as o
      where o.value is distinct from (to_jsonb(new) -> o.key);
    if changed_columns is not null then
      raise exception 'immutable columns of inbox message (%, %) cannot change: %',
        old.consumer_name, old.message_id, changed_columns;
    end if;
    if old.processed_at is not null and new.processed_at is distinct from old.processed_at then
      raise exception 'inbox message (%, %) is already processed', old.consumer_name, old.message_id;
    end if;
    return new;
  end;
  $$;`,
];

const TRIGGERS = [
  `create trigger trg_wallets_immutable before insert or update or delete on wallets
    for each row execute function wallets_immutable();`,
  `create constraint trigger trg_ledger_entry_integrity after insert on wallet_ledger_entries
    deferrable initially deferred
    for each row execute function ledger_entry_integrity();`,
  `create trigger trg_inbox_immutable before update on inbox_messages
    for each row execute function inbox_messages_immutable();`,
];
