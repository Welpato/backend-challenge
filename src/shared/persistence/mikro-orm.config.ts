import { readdirSync } from 'node:fs';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';

const MIGRATIONS_DIR = 'migrations';
const MIGRATION_PREFIX = /^(\d{4})_/;

export interface MikroOrmConfigInput {
  /** Vem do schema de env validado (`loadConfig().database.url`). */
  clientUrl: string;
  entities?: NonNullable<Options['entities']>;
}

/**
 * Configuração do MikroORM.
 *
 * - Metadata via `defineEntity`/`EntitySchema` (schema-first): não depende de `ts-morph`
 *   nem de `emitDecoratorMetadata` para o ORM, o que evita surpresas do transpiler do Bun.
 * - `forceUtcTimezone`: datas sempre gravadas/lidas em UTC.
 * - Migrations em `migrations/*.ts`, executadas via `scripts/migrate.ts` (Bun importa `.ts` direto).
 * - `clientUrl` é obrigatório e vem do schema de env validado (zod) — sem leitura direta de `process.env`.
 */
export function buildMikroOrmConfig(input: MikroOrmConfigInput): Options {
  return defineConfig({
    clientUrl: input.clientUrl,
    entities: input.entities ?? [],
    discovery: { warnWhenNoEntities: false },
    forceUtcTimezone: true,
    preferTs: true,
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      path: MIGRATIONS_DIR,
      pathTs: MIGRATIONS_DIR,
      glob: '!(*.d).ts',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      emit: 'ts',
      fileName: (_timestamp: string, name?: string) => `${nextMigrationPrefix()}_${name ?? 'migration'}`,
    },
  });
}

/**
 * Migrations seguem numeração sequencial de 4 dígitos (`0000_spike`, `0001_init`, ...),
 * em vez do timestamp padrão do MikroORM: a ordem fica explícita e legível na revisão.
 */
function nextMigrationPrefix(): string {
  const used = readdirSync(MIGRATIONS_DIR)
    .map((file) => MIGRATION_PREFIX.exec(file)?.[1])
    .filter((prefix): prefix is string => prefix !== undefined)
    .map((prefix) => Number.parseInt(prefix, 10));
  const next = used.length === 0 ? 0 : Math.max(...used) + 1;
  return next.toString().padStart(4, '0');
}
