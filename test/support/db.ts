import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import { loadConfig } from '@/config/load-config';
import { buildMikroOrmConfig } from '@/shared/persistence/mikro-orm.config';

/**
 * Helpers dos testes de integração contra o PostgreSQL real da infra de teste (.env.test).
 *
 * - `appDb()`      → role `app` (DATABASE_URL): o que a aplicação enxerga, só DML com os grants da 0001_init.
 * - `migratorDb()` → role `migrator` (MIGRATION_DATABASE_URL): dono das tabelas; usado para limpar
 *                    o banco entre testes e para provar que os triggers valem até para o dono.
 */
export const APP_TABLES = [
  'wallet_ledger_entries',
  'wager_transactions',
  'wallets',
  'outbox_messages',
  'inbox_messages',
] as const;

let app: SQL | undefined;
let migrator: SQL | undefined;

function migratorUrl(): string {
  const { migrationUrl } = loadConfig().database;
  if (migrationUrl === undefined) {
    throw new Error('MIGRATION_DATABASE_URL is required for integration tests (see .env.test)');
  }
  return migrationUrl;
}

export function appDb(): SQL {
  app ??= new SQL(loadConfig().database.url, { max: 4 });
  return app;
}

export function migratorDb(): SQL {
  migrator ??= new SQL(migratorUrl(), { max: 4 });
  return migrator;
}

export async function closeDb(): Promise<void> {
  await Promise.all([app?.close(), migrator?.close()]);
  app = undefined;
  migrator = undefined;
}

/**
 * Limpa as tabelas da aplicação como `migrator` (o `app` não tem TRUNCATE). TRUNCATE não dispara
 * os triggers de UPDATE/DELETE, então funciona inclusive no ledger append-only.
 */
export async function truncateAll(): Promise<void> {
  await migratorDb().unsafe(`truncate table ${APP_TABLES.join(', ')}`);
}

/** Roda o migrator do MikroORM como `migrator` (mesma config do `scripts/migrate.ts`). */
export async function withMigrator<T>(work: (orm: MikroORM) => Promise<T>): Promise<T> {
  const orm = await MikroORM.init(buildMikroOrmConfig({ clientUrl: migratorUrl() }));
  try {
    return await work(orm);
  } finally {
    await orm.close(true);
  }
}

interface PostgresErrorLike {
  readonly errno?: unknown;
  readonly message?: unknown;
}

/**
 * Atenção: o driver SQL do Bun decodifica `numeric` zero como `"0"` (não `"0.00"`); nos testes leia
 * dinheiro com `::text` quando a escala importar. (A persistência usa o driver `pg` via MikroORM.)
 *
 * Espera que a operação falhe com o SQLSTATE informado (o driver do Bun expõe o SQLSTATE em `errno`)
 * e, opcionalmente, com uma mensagem que case com `message`.
 */
export async function expectPgError(operation: Promise<unknown>, sqlState: string, message?: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error: unknown) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`expected PostgreSQL error ${sqlState}, but the operation succeeded`);
  }
  const error = caught as PostgresErrorLike;
  expect({ errno: error.errno, message: error.message }).toMatchObject({
    errno: sqlState,
    ...(message === undefined ? {} : { message: expect.stringMatching(message) }),
  });
}

/** SQLSTATEs usados nos testes de schema. */
export const PgError = {
  uniqueViolation: '23505',
  checkViolation: '23514',
  stringTooLong: '22001',
  raiseException: 'P0001',
  insufficientPrivilege: '42501',
} as const;
