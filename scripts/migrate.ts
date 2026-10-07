import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '@/config/load-config';
import { buildMikroOrmConfig } from '@/shared/persistence/mikro-orm.config';

/**
 * Executor de migrations via Bun (`orm.migrator`), em vez da CLI do MikroORM,
 * que depende de detecção de TypeScript/ts-node e não é necessária aqui.
 *
 * Uso:
 *   bun scripts/migrate.ts up            # aplica todas as pendentes
 *   bun scripts/migrate.ts down          # desfaz a última aplicada
 *   bun scripts/migrate.ts pending       # lista pendentes
 *   bun scripts/migrate.ts create <nome> # gera migration vazia em migrations/
 */
type Command = 'up' | 'down' | 'pending' | 'create';

const COMMANDS: readonly Command[] = ['up', 'down', 'pending', 'create'];

function parseCommand(raw: string | undefined): Command {
  const found = COMMANDS.find((command) => command === raw);
  if (!found) {
    throw new Error(`Unknown command "${raw ?? ''}". Expected one of: ${COMMANDS.join(', ')}`);
  }
  return found;
}

/**
 * O gerador do MikroORM usa o timestamp no nome da classe e no `name` gravado na tabela
 * de controle. Alinhamos ambos ao nome sequencial do arquivo (ex.: `0001_init`).
 */
function normalizeGeneratedMigration(fileName: string): void {
  const filePath = join('migrations', fileName);
  const migrationName = fileName.replace(/\.ts$/, '');
  const source = readFileSync(filePath, 'utf8')
    .replace(/class Migration\w+ extends/, `class Migration${migrationName} extends`)
    .replace(/override name = '[^']*';/, `override name = '${migrationName}';`);
  writeFileSync(filePath, source);
}

async function run(command: Command, name: string | undefined): Promise<void> {
  // DDL roda como `migrator` (MIGRATION_DATABASE_URL); sem ela, DATABASE_URL (o job do Compose já aponta para o migrator).
  const { database } = loadConfig();
  const orm = await MikroORM.init(buildMikroOrmConfig({ clientUrl: database.migrationUrl ?? database.url }));
  try {
    const migrator = orm.migrator;
    switch (command) {
      case 'up': {
        const applied = await migrator.up();
        console.log(`Applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ') || '-'}`);
        break;
      }
      case 'down': {
        const reverted = await migrator.down();
        console.log(`Reverted ${reverted.length} migration(s): ${reverted.map((m) => m.name).join(', ') || '-'}`);
        break;
      }
      case 'pending': {
        const pending = await migrator.getPending();
        console.log(`Pending: ${pending.map((m) => m.name).join(', ') || '-'}`);
        break;
      }
      case 'create': {
        if (!name) {
          throw new Error('Migration name is required: bun scripts/migrate.ts create <name>');
        }
        const result = await migrator.create(undefined, true, false, name);
        normalizeGeneratedMigration(result.fileName);
        console.log(`Created ${result.fileName}`);
        break;
      }
    }
  } finally {
    await orm.close(true);
  }
}

try {
  await run(parseCommand(process.argv[2]), process.argv[3]);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
