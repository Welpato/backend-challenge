# Progresso da implementação

Atualizado pelo agente ao final de cada fase. Fonte para o `ARCHITECTURE.md` na F15.

## Status das fases

| Fase | Status | Data | Observações |
|---|---|---|---|
| F00 Spike e esqueleto | ✅ concluída | 2026-10-07 | Go para MikroORM sob Bun. Critérios validados com PostgreSQL 16 nativo; `docker compose` falta validar no Mac (ver registro) |
| F01 Infraestrutura | ✅ concluída | 2026-10-07 | Código e testes verdes com PG 16 nativo + emulador SQS (moto). `docker compose`/LocalStack/nginx/imagem falta validar no Mac (ver registro) |
| F02 Shared kernel | ✅ concluída | 2026-10-07 | `Money` (bigint de centavos), `FailureCode` + metadados, JSON canônico, SHA-256, `Clock`. 103 testes novos |
| F03 Wallet / Ledger | ⬜ pendente | | |
| F04 WagerTransaction / ReversalPolicy | ⬜ pendente | | |
| F05 Eventos / Inbox / Outbox | ⬜ pendente | | |
| F06 Schema | ⬜ pendente | | |
| F07 Persistência | ⬜ pendente | | |
| F08 Wallet HTTP | ⬜ pendente | | |
| F09 ProcessWagerTransaction | ⬜ pendente | | |
| F10 Reversões e reprocessador | ⬜ pendente | | |
| F11 Publisher da outbox | ⬜ pendente | | |
| F12 Consumidor SQS | ⬜ pendente | | |
| F13 Concorrência multi-instância | ⬜ pendente | | |
| F14 Observabilidade | ⬜ pendente | | |
| F15 Documentação | ⬜ pendente | | |
| F16 Teste de carga | ⬜ pendente | | |
| F17 Auditoria final | ⬜ pendente | | |

Legenda: ⬜ pendente · 🟨 em andamento · ✅ concluída · ⛔ bloqueada

## Decisões tomadas durante a implementação

<!-- Formato: - [FNN] decisão — motivo -->
- [F00] **Go para MikroORM 7 sob Bun** — conexão, `em.transactional()`, `LockMode.PESSIMISTIC_WRITE` (gera `select … for update`), rollback e migrator funcionaram sem contorno.
- [F00] **Metadata do ORM via `defineEntity` (EntitySchema schema-first)**, não `ReflectMetadataProvider` nem `@mikro-orm/reflection` — no MikroORM 7 o `@mikro-orm/reflection` é ts-morph e os decorators foram para `@mikro-orm/decorators/legacy`; schema-first não depende de `emitDecoratorMetadata` para o ORM e já infere os tipos do record. Os records da F07 devem seguir esse estilo.
- [F00] **Decimal mapeado com `p.decimal('string').precision(20).scale(2)`** — `numeric(20,2)` volta como string tanto do driver `pg` quanto do ORM (testado com `25.00` e `123456789012345678.99`). O `money.type.ts` da F07 parte daqui.
- [F00] **Lint/format com Biome 2.5** (não ESLint) — um binário, zero plugins, rápido. Regra `style/useImportType` desligada: `import type` apaga a referência que o Nest precisa em `design:paramtypes` para DI por tipo. `noExplicitAny` como erro.
- [F00] **Execução direta com `bun src/main.ts`** (sem `bun build`) para `dev` (`--watch`) e `start`. O transpiler do Bun respeita `experimentalDecorators` + `emitDecoratorMetadata` do `tsconfig.json`; `reflect-metadata` é carregado por preload no `bunfig.toml` (também em `[test]`) e importado na 1ª linha do `main.ts`/`scripts/migrate.ts`.
- [F00] **Migrations rodam por `scripts/migrate.ts`** (`orm.migrator` com `up`/`down`/`pending`/`create`), sem a CLI do MikroORM. `preferTs: true`, `pathTs: migrations`, `snapshot: false`, cada lote em transação (`allOrNothing`). Nome das migrations é sequencial de 4 dígitos (`0000_spike`, `0001_init`…); o `create` normaliza classe e `name` gerados pelo MikroORM para o nome do arquivo. Tabela de controle: `mikro_orm_migrations`.
- [F00] **Alias `@/*` → `src/*`** resolvido por Bun e por `tsc` (`moduleResolution: bundler`, `module: Preserve`, sem `baseUrl`).
- [F00] **TypeScript 7.0.2** (compilador nativo) só para `typecheck`; aceitou `experimentalDecorators`/`emitDecoratorMetadata`/`exactOptionalPropertyTypes` sem ajuste. Se der problema em fase futura, cair para 5.9.x é seguro (Bun não usa o `tsc`).
- [F00] **NestJS 12** com `@nestjs/platform-express`. DI por tipo sem `@Inject` validada (teste checa `design:paramtypes` e resolve o controller pelo container).
- [F01] **Config validada por zod em `src/config/`** (`loadConfig(env)` → `AppConfig` imutável, injetado por `@Inject(APP_CONFIG)`). Só `DATABASE_URL` é obrigatória; variáveis vazias contam como ausentes; inteiros só em string decimal; todas as violações são reportadas juntas e o `main.ts` sai com código 1 e log JSON `fatal`. `buildMikroOrmConfig` não lê mais `process.env` (`clientUrl` obrigatório). Credenciais AWS ficam fora do schema (cadeia padrão do SDK).
- [F01] **`nestjs-pino` 5.3.1** (não 5.2.x): o NestJS 12 é ESM e as versões ≤ 5.2 do `nestjs-pino` são só CJS — o Bun não faz `require()` de módulo ESM com top-level await. 5.3.x é a primeira com build ESM. Demais versões novas: `zod` 4.6.5, `pino` 10.3.1, `pino-http` 11.0.0, `prom-client` 15.1.3, `@aws-sdk/client-sqs` 3.1136.0 (todas fixadas).
- [F01] **Logs**: `correlationId` vem de `AsyncLocalStorage` via `mixin` do pino (aparece em qualquer log dentro da requisição, inclusive do Nest); `instanceId` e `role` em `base`. O middleware de correlação é registrado com `app.use` antes dos middlewares de módulo (o id do pino-http é o mesmo). Redaction: o fast-redact não aceita `*.balance*`, então as variações (`balance`, `balanceAfter`, `balance_after_amount`…) + `money`/`amount` são listadas em até 3 níveis, mais `req.body`/`body`/`payload`/`authorization`/`cookie` (`src/shared/observability/log-redaction.ts`). Requisições 2xx em `/health/*` e `/metrics` logam em `debug` (probes a cada 5s inundariam o `info`).
- [F01] **`X-Correlation-Id` recebido só é aceito se casar `^[A-Za-z0-9._:-]{1,128}$`**; senão gera UUID v7 (`Bun.randomUUIDv7()`, em `src/shared/ids.ts`) — evita injeção em header/log.
- [F01] **Readiness**: indicadores `postgres` (`select 1` pelo pool do MikroORM) e `sqs` (`GetQueueUrl` cacheado + `GetQueueAttributes` na `wager-transactions.fifo`) em paralelo, cada um com timeout (`HEALTH_CHECK_TIMEOUT_MS`, 2s) e `AbortSignal`. O flag de shutdown liga em `onModuleDestroy` (primeiro hook do `app.close()`), antes de o servidor HTTP fechar. 503 devolve o relatório completo. Liveness não consulta dependências. O MikroORM conecta de forma preguiçosa: a app sobe com o PG fora e o ready fica 503.
- [F01] **ORM e SQS como providers globais simples** (`DatabaseModule` com `MikroORM.init`, `SqsModule` com `SQSClient` + `SqsQueueUrls`), fechados em `onApplicationShutdown`. A F07 pode trocar o wiring do ORM por `@mikro-orm/nestjs`. Com endpoint customizado o cliente usa `useQueueUrlAsEndpoint: false` e o LocalStack roda com `SQS_ENDPOINT_STRATEGY=path` — a app não depende do hostname que o LocalStack escreve nas URLs.
- [F01] **Papéis**: `AppModule.forRole(config)`; todos os papéis sobem HTTP com health + `/metrics` (registry próprio com labels `role`/`instance_id`). Os módulos por papel estão vazios até F08–F12 (mapa `ROLE_MODULES` em `app.module.ts`). `src/create-app.ts` monta a app e é reutilizado pelos testes de integração (`test/support/test-app.ts`).
- [F01] **PostgreSQL**: `docker/postgres-init.sql` cria `migrator` (USAGE+CREATE no schema `public`) e `app` (só USAGE + `lock_timeout = '3s'` no role). O job `migrate` conecta como `migrator`; api/workers como `app`. Os GRANTs de tabela ficam para a 0001_init (F06), que deve rodar como `migrator`.
- [F01] **LocalStack fixado em `localstack/localstack:4.14`**: a partir da release 2026.03 (calendar versioning) a imagem exige `LOCALSTACK_AUTH_TOKEN`; 4.14 é a última semver. Sobrescrevível com `LOCALSTACK_IMAGE` (o token é repassado se existir). Plano B registrado na fase: MiniStack.
- [F01] **Compose**: projeto `jungle-wagering` (volume novo → o init de roles roda); imagem única `jungle-wagering:local` (`oven/bun:1`, multi-stage, `--production`, usuário `bun`); 3 réplicas de `api`, `consumer`, `outbox` e `reprocessor` (env `*_REPLICAS`); healthchecks via `scripts/healthcheck.ts` (a imagem do Bun não tem curl); nginx 1.29 com `server api:3000 resolve` (re-resolve o DNS do Docker, distribui entre as réplicas) e `proxy_next_upstream error timeout` (nunca repete POST). `migrate` é one-shot (`service_completed_successfully`).
- [F01] **Infra de teste**: `docker-compose.test.yml` (projeto `jungle-wagering-test`, PG em `:5433` com tmpfs e fsync off, LocalStack em `:4567`, mesmos scripts de init). `.env.test` (versionado, sem segredos) é carregado pelo `bun test`; `test:integration` roda `scripts/wait-for-infra.ts` antes. O spike da F00 passou a usar essa infra.
- [F01] **Biome**: `complexity/noStaticOnlyClass` desligada — `static forRoot()` em módulos é o padrão de módulos dinâmicos do Nest.
- [F02] **`Money` guarda `bigint` de centavos em propriedade TS `private readonly cents`** (não `#cents`): campos `#` são ignorados pelo `toEqual` do `bun:test`, e dois `Money` de valores diferentes passariam como iguais em testes futuros. A instância é `Object.freeze`. Parse via regex + `split('.')` + `BigInt`; formatação via `bigint` `/`/`%` + `padStart`. Nenhum `number` no fluxo.
- [F02] **Resultados de operação limitados a `NUMERIC(20,2)`** (|valor| ≤ 999999999999999999.99): `fromCents` lança `InvalidMoneyError` se estourar, em vez de deixar o erro aparecer só no INSERT. Negativos continuam permitidos (`subtract`, `negate`); `negate()` de zero continua zero (`"0.00"`, não `"-0.00"`).
- [F02] **`from` também rejeita `props` que não seja objeto, `amount` que não seja string (number, bigint) e moeda ausente**; mensagens de erro em inglês e **sem ecoar o valor recebido** (logs/respostas não carregam dinheiro).
- [F02] **Códigos dos erros de `Money`**: `InvalidMoneyError` → `VALIDATION_ERROR` (contrato); `CurrencyMismatchError` → `CURRENCY_MISMATCH` (expõe `expected`/`actual`). `DomainError` é abstrata, com `code: FailureCode | string` e `name` = nome da subclasse.
- [F02] **`FailureCode`** é um objeto `as const` + tipo homônimo; `failureCodeMetadata(code)` devolve `{ class, retryable, persisted }` congelado, com `class ∈ business|contract|conflict|not_found|transient|infrastructure` e `persisted ∈ 'REJECTED'|'FAILED'|null`. Só `TRANSIENT_UNAVAILABLE` é `retryable` (reenviar a mesma operação com a mesma key). `isFailureCode` para validar strings vindas do banco/de fora.
- [F02] **JSON canônico**: chaves ordenadas por code unit UTF-16 (`Array#sort`, mesma regra do RFC 8785), sem espaços, propriedades `undefined` omitidas, objetos com `toJSON()` (ex.: `Money`, `Date`) serializados pelo resultado. Rejeitados (`CanonicalJsonError`): number não inteiro ou fora do intervalo seguro, `NaN`/`Infinity`, `bigint`, função, símbolo, `undefined` no topo ou **dentro de array** (sem representação sem ambiguidade), instâncias não simples sem `toJSON` (ex.: `Map`) e ciclos. O mesmo objeto repetido sem ciclo é aceito.
- [F02] **`sha256Hex` via `node:crypto`** (`createHash`, UTF-8, hex minúsculo) — funciona no Bun e não amarra o shared kernel ao global `Bun`.
- [F02] **`FixedClock`** (em `src/shared/clock.ts`, como pede a fase) aceita `Date | string`, devolve cópias, tem `set`/`advance(ms)` e rejeita datas inválidas. Não foi criado token de DI para `Clock`; quem precisar injetar (F07+) cria o token.

## Bloqueios / dúvidas

<!-- Formato: - [FNN] descrição — o que precisa ser decidido -->
- [F00] `docker compose up -d postgres` não foi executado pelo agente (o ambiente dele não alcança o Docker Hub); a validação usou PostgreSQL 16.15 nativo com o mesmo usuário/senha/banco do compose. Wesley: rodar os critérios de aceite no Mac uma vez para fechar esse ponto.
- [F01] **Critérios com Docker não executados pelo agente**: o ambiente dele não alcança nenhum registry de imagens (Docker Hub, ECR público, GHCR, mirror.gcr.io → 403) e o LocalStack não roda fora da imagem. Validado em vez disso: PG 16.15 nativo (init SQL aplicado de verdade, `migrate` como `migrator`, app como `app`), emulador SQS `moto` com o **mesmo** `docker/localstack-init.sh`, install `--production` igual ao do Dockerfile, 3 instâncias da app e `docker compose config` dos dois arquivos. **Wesley: rodar no Mac** os critérios de aceite da F01 (bloco abaixo) e o `bun run test:integration` contra o `docker-compose.test.yml` — em especial o teste `moves a FIFO message that is never acked to the FIFO DLQ`, que é a armadilha da fase (FIFO + redrive no LocalStack). Se a tag `4.14` não existir ou pedir token, testar `LOCALSTACK_IMAGE=localstack/localstack:4.12` antes de pensar em MiniStack.

## Registro por fase

<!--
### FNN — nome
- Arquivos criados/alterados:
- Resultado dos critérios de aceite (resumo dos comandos):
- Pendências para a próxima fase:
-->

### F00 — Spike e esqueleto
- Arquivos criados: `package.json`, `bun.lock`, `tsconfig.json`, `bunfig.toml`, `biome.json`, `docker-compose.yml` (só `postgres:16`), `.env.example`, `.gitignore`, `src/main.ts`, `src/app.module.ts`, `src/health/{health.module,health.controller,health.service}.ts`, `src/shared/persistence/mikro-orm.config.ts`, `scripts/migrate.ts`, `migrations/0000_spike.ts`, `test/unit/smoke.test.ts`, `test/integration/spike/{orm-spike.test,spike-account.record}.ts`.
- Versões (fixadas sem `^`): Bun 1.4.2 · `@nestjs/{core,common,platform-express}` 12.1.2 · `@mikro-orm/{core,postgresql,migrations}` 7.2.4 · `reflect-metadata` 0.2.2 · `rxjs` 7.8.2 · dev: `typescript` 7.0.2, `@biomejs/biome` 2.5.15, `@types/bun` 1.4.2.
- Resultado dos critérios de aceite (PostgreSQL 16.15 nativo, banco recriado do zero e `node_modules` reinstalado):
  - `bun install` → 128 pacotes; `bun run typecheck` → limpo; `bun run lint` → `Checked 14 files … No fixes applied`.
  - `migrate:up` → `Applied 1 migration(s): 0000_spike`; `migrate:down` → `Reverted 1 migration(s): 0000_spike` (tabela some); `migrate:up` de novo → aplicada. `migrate:create probe` gerou `0001_probe.ts` com classe/nome normalizados (arquivo removido depois).
  - `bun test test/unit` → 3 pass / 0 fail (Bun 1.x, `design:paramtypes`, DI do controller sem `@Inject`).
  - `bun run test:integration` → 5 pass / 0 fail: numeric como string (driver e ORM), valor de 18 dígitos exato, commit + rollback em `em.transactional()`, `PESSIMISTIC_WRITE` serializa escritores da mesma linha (o 2º só trava depois do commit do 1º, ~300 ms), linhas diferentes não se bloqueiam.
  - `bun run dev` + `curl -s localhost:3000/health/live` → `{"status":"ok"}`.
- Pendências para a F01:
  - Validar `docker compose up -d postgres` no Mac e então expandir o compose (LocalStack, nginx, papéis via `APP_ROLE`).
  - `DATABASE_URL`/`PORT` hoje são lidos direto de `process.env` com default em `mikro-orm.config.ts` e `main.ts`; mover para o schema de env (zod) em `src/config/`.
  - `HealthService`/`health/live` é provisório; a F01 cria os health checks reais.
  - Integração do ORM com o Nest (`@mikro-orm/nestjs` 7.1.0 existe) não foi feita — fica para quando houver records (F07); o spike usa `MikroORM.init` direto.
  - `migrations/0000_spike.ts` e `test/integration/spike/` são descartáveis: remover/substituir na F06 (`0001_init`). Atenção: quem já rodou `0000_spike` terá a linha na `mikro_orm_migrations` — a F06 deve fazer `migrate:down` antes de apagar o arquivo ou recriar o volume.
  - `bun run test:concurrency` está no CLAUDE.md mas o script só nasce na F13.

### F01 — Infraestrutura
- Arquivos criados: `Dockerfile`, `.dockerignore`, `docker-compose.test.yml`, `.env.test`, `docker/{postgres-init.sql,localstack-init.sh,nginx.conf}`, `scripts/{healthcheck,wait-for-infra}.ts`, `src/create-app.ts`, `src/config/{env.schema,app-config,load-config,config.module}.ts`, `src/shared/ids.ts`, `src/shared/observability/{correlation,log-redaction,logger.module,metrics.module,metrics.controller}.ts`, `src/shared/persistence/database.module.ts`, `src/messaging/sqs/{sqs.client,sqs.module}.ts`, `src/health/{health-indicator,postgres.indicator,sqs.indicator,readiness.service}.ts`, `test/support/test-app.ts`, `test/unit/config/load-config.test.ts`, `test/unit/shared/observability/{correlation,logger}.test.ts`, `test/unit/health/readiness.service.test.ts`, `test/integration/infra/{health,sqs-queues}.test.ts`.
- Arquivos alterados: `docker-compose.yml` (stack completa), `package.json`/`bun.lock` (deps + scripts `test:integration`, `infra:test:up|down`, `infra:wait`), `biome.json`, `.env.example`, `CLAUDE.md` (comandos), `src/main.ts`, `src/app.module.ts`, `src/health/{health.controller,health.module}.ts`, `src/shared/persistence/mikro-orm.config.ts`, `scripts/migrate.ts`, `test/unit/smoke.test.ts`, `test/integration/spike/orm-spike.test.ts`. Removido: `src/health/health.service.ts` (provisório da F00).
- Resultado (PG 16.15 nativo em 5432/5433 + `moto` em 4566/4567 no lugar do LocalStack):
  - `bun run typecheck` → limpo; `bun run lint` → `Checked 40 files … No fixes applied`, sem warnings.
  - `bun test test/unit` → 21 pass / 0 fail (config, correlação, logger/redaction, readiness, smoke).
  - `bun run test:integration` → `postgres: ready`, `sqs: ready`, 16 pass / 0 fail (5 do spike F00 + health real com 200/503 para SQS e PG fora + filas FIFO, atributos, RedrivePolicy e mensagem não confirmada indo para a DLQ após 5 recebimentos).
  - `docker/localstack-init.sh` rodado 2× (idempotente) → 3 filas; `get-queue-attributes` → `FifoQueue=true`, `ContentBasedDeduplication=false`, `VisibilityTimeout=30`, `RedrivePolicy={deadLetterTargetArn: …wager-transactions-dlq.fifo, maxReceiveCount: 5}`.
  - App real: `/health/ready` → 200 `{"status":"ok",…,"checks":{"postgres":{"status":"up"},"sqs":{"status":"up"}}}`; com SQS em porta fechada → 503 (`sqs: down`); com PG fora → 503 e `/health/live` 200; `X-Correlation-Id: abc-123` ecoado, sem header → UUID v7; SIGTERM → encerra limpo; env inválida (`APP_ROLE=bogus PORT=abc` sem `DATABASE_URL`) → log `fatal` com as 3 violações e exit 1.
  - Log de requisição: `{"level":"warn","time":"…","instanceId":"local-1","role":"api","req":{"id":"req-42",…},"correlationId":"req-42","res":{"statusCode":404,…},"msg":"request completed"}`.
  - Imagem simulada: `bun install --frozen-lockfile --production --ignore-scripts` (164 pacotes) + `migrate up` como `migrator` (tabelas com owner `migrator`) + 3 instâncias `APP_ROLE=api` como `app` → `scripts/healthcheck.ts ready` exit 0 nas três; `show lock_timeout` do `app` → `3s`.
  - `docker compose config --quiet` e `docker compose -f docker-compose.test.yml config --quiet` → ok.
- **A validar no Mac** (não executado — sem registry de imagens):
  ```bash
  docker compose down -v                     # se houver stack antiga da F00
  docker compose up -d --build && docker compose ps
  curl -s localhost:8080/health/ready
  curl -si localhost:8080/health/live | grep -i x-correlation-id
  for i in 1 2 3 4 5 6; do curl -s localhost:8080/health/live; echo; done   # instanceId alterna entre as 3 réplicas
  aws --endpoint-url http://localhost:4566 sqs list-queues
  aws --endpoint-url http://localhost:4566 sqs get-queue-attributes --queue-url <url da wager-transactions.fifo> --attribute-names RedrivePolicy
  docker compose stop localstack && curl -s -o /dev/null -w '%{http_code}' localhost:8080/health/ready   # 503
  docker compose start localstack
  bun run infra:test:up && bun run test:integration
  ```
- Pendências para as próximas fases:
  - F06: a `0001_init` deve rodar como `migrator` e dar os GRANTs ao `app` (INSERT/SELECT no ledger, sem UPDATE/DELETE). Testes de integração hoje conectam como superusuário `wagering`; quando os grants existirem, vale ter um teste que conecte como `app` e confirme que UPDATE/DELETE no ledger falham por permissão.
  - F06: remover `0000_spike`/`test/integration/spike` (ver pendência da F00).
  - F07: `lock_timeout` já está no role `app`; a F07 ainda deve fixá-lo na transação (`SET LOCAL lock_timeout`, `DB_LOCK_TIMEOUT_MS`) para não depender do role.
  - F11/F12/F10: registrar os workers em `ROLE_MODULES` (`src/app.module.ts`); `SHUTDOWN_GRACE_MS`, `SQS_*`, `OUTBOX_POLL_INTERVAL_MS`, `REPROCESSOR_INTERVAL_MS`, `PENDING_REFERENCE_*` e `FAULT_EXIT_AFTER_COMMIT` já estão no schema de config.
  - F14: métricas de negócio no `Registry` exportado pelo `MetricsModule`; o filtro de log em `debug` para `/health` e `/metrics` está em `logger.module.ts`.
  - `src/shared/ids.ts` só tem `newUuidV7()`; a F02 completa o módulo se precisar.

### F02 — Shared kernel
- Arquivos criados: `src/shared/failure-code.ts`, `src/shared/errors/domain-error.ts`, `src/shared/money/{money-props,money,money.errors}.ts`, `src/shared/canonical-json.ts`, `src/shared/hashing.ts`, `src/shared/clock.ts`, `test/unit/shared/money/money.test.ts`, `test/unit/shared/{failure-code,canonical-json,hashing,clock,ids}.test.ts`. `src/shared/ids.ts` já atendia (UUID v7) e não mudou — ganhou teste.
- Resultado dos critérios de aceite:
  - `bun test test/unit/shared` → 111 pass / 0 fail (Money: válidos, 19 entradas inválidas + number/bigint/null, moedas inválidas, `0.10 + 0.20 == 0.30`, 1.000.000 × `0.01` = `10000.00`, limite de 18 dígitos, negativos, imutabilidade/`Object.isFrozen`, BRL × USD em `add`/`subtract`/`isLessThan`/`equals`; FailureCode; JSON canônico; hash com vetores conhecidos; clock; ids).
  - `bun run typecheck` → limpo; `bun run lint` → `Checked 54 files … No fixes applied`.
  - `grep -rnE "parseFloat|Number\(|toFixed|: number" src/shared/money …` → `ok`.
  - Fases anteriores: `bun test test/unit` → 124 pass / 0 fail; `bun run test:integration` → 16 pass / 0 fail (PG 16 nativo em :5433 com `docker/postgres-init.sql` + `moto` em :4567 com `docker/localstack-init.sh`, mesmo arranjo da F01).
- Pendências para as próximas fases:
  - F03/F04: `InsufficientFundsError`, `InvalidTransactionStateError` etc. devem estender `DomainError` com o `FailureCode` correspondente (ou string para erros de programação).
  - F08: `WALLET_ALREADY_EXISTS` (409, §5 `CreateWallet`) não está na tabela §3.8 e por isso não entrou no catálogo `FailureCode`; a F08 decide se o adiciona ao catálogo (classe `conflict`, não persistido) ou usa como string no `DomainError`.
  - F08/F12: entrada monetária dos DTOs/envelopes deve passar por `Money.from` (já rejeita negativos); `toJSON()` de um `Money` negativo devolve `amount` com sinal — só pode aparecer em saídas internas (ex.: `difference` da reconciliação), nunca em contrato de entrada.
  - F09: `payload-hash.ts` = `sha256Hex(canonicalJson({...}))` com os campos de §6; passar `money` como `MoneyProps` (ou o próprio `Money`, que serializa via `toJSON`) e deixar `referenceExternalTransactionId` como `undefined` quando ausente (é omitido). Nunca passar `null` para opcionais — `null` entra no hash.
