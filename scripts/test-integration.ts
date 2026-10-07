/**
 * Runner dos testes de integração contra a infra real (docker-compose.test.yml):
 *   1. espera PostgreSQL e as filas do LocalStack (scripts/wait-for-infra.ts);
 *   2. aplica as migrations como `migrator` (scripts/migrate.ts up, MIGRATION_DATABASE_URL do .env.test);
 *   3. roda `bun test` nos caminhos recebidos (default: test/integration).
 *
 *   bun run test:integration                              # tudo em test/integration
 *   bun run test:integration -- test/integration/schema   # só um diretório/arquivo
 *   bun run test:integration:up                           # sobe a infra de teste antes
 *
 * Cada passo roda num processo separado e herda o ambiente deste. Por isso este script precisa
 * rodar com NODE_ENV=test (o script do package.json já define): sem isso o Bun carregaria o `.env`
 * de desenvolvimento aqui e repassaria a DATABASE_URL de dev para os filhos, que tem precedência
 * sobre o `.env.test`.
 */
// Módulo ES (top-level await) sem imports.
export {};

const DEFAULT_TARGETS = ['test/integration'];

async function step(name: string, command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    console.error(`${name} failed (exit code ${exitCode})`);
    process.exit(exitCode);
  }
}

// `bun run test:integration -- <paths>` pode repassar o `--` literal.
if (process.env.NODE_ENV !== 'test') {
  console.error('Run with NODE_ENV=test (use `bun run test:integration`) so that .env.test is loaded.');
  process.exit(1);
}

const targets = process.argv.slice(2).filter((arg) => arg !== '--');

await step('wait-for-infra', ['bun', 'scripts/wait-for-infra.ts']);
await step('migrate', ['bun', 'scripts/migrate.ts', 'up']);
await step('bun test', ['bun', 'test', ...(targets.length > 0 ? targets : DEFAULT_TARGETS)]);
