# F00 — Spike e esqueleto (Bun + NestJS + MikroORM)

## Objetivo
Provar que a stack obrigatória funciona junta **sob Bun** antes de escrever qualquer regra de negócio, e deixar o esqueleto do repositório pronto. É a fase de maior risco técnico: se algo não funcionar, decidir aqui o contorno (ou o fallback para TypeORM).

## Ler
- `CLAUDE.md`; `ESPECIFICACAO.md` §2 (linha ORM) e §9.

## Entregáveis
- `package.json` com scripts: `dev`, `start`, `typecheck` (`tsc --noEmit`), `lint` (Biome **ou** ESLint — escolher um e registrar), `test:unit`, `migrate:up`, `migrate:down`, `migrate:create`.
- `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `experimentalDecorators`, `emitDecoratorMetadata`, `target` ES2022, paths `@/*` → `src/*` (se usar paths, confirmar que Bun e `tsc` resolvem).
- `bunfig.toml` se necessário (preload de `reflect-metadata`).
- `src/main.ts` + `src/app.module.ts` mínimos; controller temporário `GET /health/live` → `{ status: "ok" }`.
- `src/shared/persistence/mikro-orm.config.ts` com `@mikro-orm/postgresql`, metadata via `ReflectMetadataProvider` (ou `EntitySchema`, sem ts-morph), `forceUtcTimezone: true`.
- Migration de teste `migrations/0000_spike.ts` que cria e remove uma tabela trivial, rodada via **script Bun** (`scripts/migrate.ts` usando `orm.getMigrator()`), não via CLI do MikroORM se a CLI falhar sob Bun.
- `docker-compose.yml` mínimo só com `postgres:16` (a infra completa vem na F01).
- `test/unit/smoke.test.ts` com `bun test`.

## Verificar especificamente
1. Decorators do Nest com DI por tipo funcionam no Bun (injetar um service num controller sem `@Inject` explícito).
2. MikroORM conecta, roda `em.transactional()` e `em.findOne(..., { lockMode: LockMode.PESSIMISTIC_WRITE })` contra uma tabela de teste.
3. Coluna `numeric(20,2)` volta como **string** no driver (escrever um teste rápido).
4. `migrate:up` e `migrate:down` funcionam.
5. `bun build` ou execução direta (`bun src/main.ts`) — escolher e registrar.

## Critérios de aceite
```bash
docker compose up -d postgres
bun install
bun run typecheck && bun run lint
bun run migrate:up && bun run migrate:down && bun run migrate:up
bun test test/unit
bun run dev &   # depois:
curl -s localhost:3000/health/live   # → {"status":"ok"}
```

## Go / no-go
- Se MikroORM não funcionar sob Bun depois de tentativas razoáveis (≤ 2h de esforço do agente): registrar o erro exato em `PROGRESSO.md`, marcar ⛔ e **parar** — a troca para TypeORM é decisão do Wesley.

## Fora de escopo
Qualquer entidade de domínio, LocalStack, logs estruturados.

## Armadilhas
- `reflect-metadata` precisa ser importado antes de qualquer módulo Nest (preload no `bunfig.toml` ou primeira linha do `main.ts`).
- Não deixar a migration de spike no estado final: remova-a na F06 ou registre que será substituída.
