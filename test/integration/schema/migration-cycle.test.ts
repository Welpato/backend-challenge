import { afterAll, describe, expect, it } from 'bun:test';
import { APP_TABLES, closeDb, migratorDb, withMigrator } from '../../support/db';

// up → down → up de todas as migrations (0001_init + 0002_schema_hardening) contra o PostgreSQL real, como
// `migrator`. Termina com o schema aplicado.
const APP_FUNCTIONS = [
  'inbox_messages_immutable',
  'inbox_messages_no_delete',
  'ledger_append_only',
  'ledger_entry_integrity',
  'outbox_messages_immutable',
  'wager_transactions_immutable',
  'wallet_ledger_consistency',
  'wallets_immutable',
];

async function existingTables(): Promise<string[]> {
  const rows: { table_name: string }[] = await migratorDb()`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name in ${migratorDb()(APP_TABLES)}
    order by table_name`;
  return rows.map((row) => row.table_name);
}

async function existingFunctions(): Promise<string[]> {
  const rows: { proname: string }[] = await migratorDb()`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ${migratorDb()(APP_FUNCTIONS)}
    order by p.proname`;
  return rows.map((row) => row.proname);
}

afterAll(async () => {
  await closeDb();
});

describe('migrations 0001_init and 0002_schema_hardening', () => {
  it('runs up → down → up without errors', async () => {
    await withMigrator(async (orm) => {
      await orm.migrator.up();
      expect((await orm.migrator.getExecuted()).map((m) => m.name)).toEqual(['0001_init', '0002_schema_hardening']);

      await orm.migrator.down({ to: 0 });
      expect(await orm.migrator.getExecuted()).toEqual([]);
      expect(await existingTables()).toEqual([]);
      expect(await existingFunctions()).toEqual([]);

      await orm.migrator.up();
      expect((await orm.migrator.getExecuted()).map((m) => m.name)).toEqual(['0001_init', '0002_schema_hardening']);
    });

    expect(await existingTables()).toEqual([...APP_TABLES].sort());
    expect(await existingFunctions()).toEqual(APP_FUNCTIONS);
  });

  it('creates the guard triggers, with the wallet/ledger and ledger integrity checks deferred to commit', async () => {
    const rows: { table: string; trigger: string; deferrable: boolean; deferred: boolean }[] = await migratorDb()`
      select c.relname as table, t.tgname as trigger, t.tgdeferrable as deferrable, t.tginitdeferred as deferred
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname in ${migratorDb()(APP_TABLES)}
      order by c.relname, t.tgname`;

    expect(rows).toEqual([
      { table: 'inbox_messages', trigger: 'trg_inbox_immutable', deferrable: false, deferred: false },
      { table: 'inbox_messages', trigger: 'trg_inbox_no_delete', deferrable: false, deferred: false },
      { table: 'outbox_messages', trigger: 'trg_outbox_immutable', deferrable: false, deferred: false },
      { table: 'wager_transactions', trigger: 'trg_tx_immutable', deferrable: false, deferred: false },
      { table: 'wallet_ledger_entries', trigger: 'trg_ledger_append_only', deferrable: false, deferred: false },
      { table: 'wallet_ledger_entries', trigger: 'trg_ledger_entry_integrity', deferrable: true, deferred: true },
      { table: 'wallet_ledger_entries', trigger: 'trg_wallet_ledger_consistency', deferrable: true, deferred: true },
      { table: 'wallets', trigger: 'trg_wallet_ledger_consistency', deferrable: true, deferred: true },
      { table: 'wallets', trigger: 'trg_wallets_immutable', deferrable: false, deferred: false },
    ]);
  });

  it('grants the app role only DML, with SELECT/INSERT on the ledger and no DELETE anywhere', async () => {
    const rows: { table_name: string; privileges: string }[] = await migratorDb()`
      select table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
      from information_schema.role_table_grants
      where grantee = 'app' and table_schema = 'public'
      group by table_name
      order by table_name`;

    expect(rows).toEqual([
      { table_name: 'inbox_messages', privileges: 'INSERT,SELECT,UPDATE' },
      { table_name: 'outbox_messages', privileges: 'INSERT,SELECT,UPDATE' },
      { table_name: 'wager_transactions', privileges: 'INSERT,SELECT,UPDATE' },
      { table_name: 'wallet_ledger_entries', privileges: 'INSERT,SELECT' },
      { table_name: 'wallets', privileges: 'INSERT,SELECT,UPDATE' },
    ]);
  });
});
