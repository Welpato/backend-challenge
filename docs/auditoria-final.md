# Auditoria final contra o enunciado (F17)

Revisão do repositório contra `docs/plano/DESAFIO.md`, item a item, antes da entrega. Data: 2026-10-08.

**Como foi feita.** Duas passadas: (1) um agente revisor **independente**, em contexto novo, sem ter implementado
nenhuma fase, leu o enunciado, a especificação, a documentação e o código e devolveu problemas com `arquivo:linha`
(somente leitura); (2) cada achado foi conferido por quem fecha a fase — reproduzido quando possível — e as
evidências abaixo foram checadas no código e nos testes. Os comandos de aceite rodaram com PostgreSQL 16 nativo e o
emulador `moto` (mesmos scripts de init), porque este ambiente não alcança registry de imagens Docker — a rodada com
`docker compose` fica para o Mac (ver "Pendências").

Legenda: ✅ atendido · ⚠️ atendido com limitação registrada no ARCHITECTURE · ❌ não atendido.

## Eliminatórias

| Item | | Evidência |
|---|---|---|
| Nenhum `number`/float para dinheiro | ✅ | `grep -rnE "parseFloat\|Number\(\|toFixed\|amount: number" src` → só versões/config/limite de página (`shared/persistence/record-conversion.ts:16`, `wallet/http/wallet.dto.ts:48`, `messaging/sqs/wager-queue.ts:47`, `shared/persistence/mikro-orm.config.ts:60`). `Money` guarda `bigint` de centavos (`shared/money/money.ts`); somas da reconciliação voltam do PostgreSQL como texto |
| Nenhum caminho deixa saldo negativo | ✅ | `CHECK (balance >= 0)` e `balance_before/after >= 0` (`migrations/0001_init.ts:49,102-103`); `test/integration/schema/wallets.test.ts` "rejects a negative balance"; race 100 + 2×80 em `test/concurrency/single-process/wagering-concurrency.test.ts` e `multi-instance/02-competing-bets.test.ts` (×20) |
| Nenhum débito/crédito duplicado | ✅ | `uq_ledger_transaction_wallet`, `uq_ledger_wallet_version`, `ux_reversal_once` (`0001_init.ts:106-107,141`); `multi-instance/01-same-bet-50x.test.ts` (1 DEBIT, 49 replays), `05-consumer-crash.test.ts` (redelivery após commit), `test/integration/sqs/consumer-recovery.test.ts`; teste de carga: lançamentos = transações que movem saldo em todos os cenários |
| Idempotência 100% no banco | ✅ | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, inbox com PK `(consumer_name, message_id)`; `INSERT … ON CONFLICT DO NOTHING` (`wagering/application/process-wager-transaction.ts`). Nenhum `Map`/`Set`/LRU de dedup em `src/` (os `Map` do consumidor só rastreiam mensagens em voo) |
| Correto com ≥ 3 instâncias | ✅ | `test/concurrency/multi-instance/*` — processos `bun src/main.ts` reais (3 APIs, 3 consumidores, 2 publishers, 2 reprocessadores); 3 rodadas seguidas verdes (ver "Resultados") |
| Nenhum `SendMessage` de evento fora do publisher | ✅ | Únicos envios em `src/`: `messaging/outbox/sqs-event-publisher.ts:46` (eventos) e `messaging/sqs/wager-queue.ts:141` (cópia para a DLQ, não é evento). `test/integration/outbox/outbox-publisher.test.ts` "publishes an event only after its transaction commits" |
| Ledger auditável e append-only | ✅ | `trg_ledger_append_only` + `app` só com `SELECT, INSERT` (`0001_init.ts:246,264`); `test/integration/schema/ledger.test.ts` "blocks UPDATE and DELETE even for the table owner" e "denies UPDATE and DELETE to the app role". ⚠️ `TRUNCATE` pelo dono (`migrator`) continua possível — registrado no ARCHITECTURE §14 |
| Testes de integração/concorrência com PG e SQS reais | ✅ | `docker-compose.test.yml` / `scripts/test-integration.ts`; nenhum mock de banco ou fila. Os únicos `spyOn` injetam uma falha real de INSERT na mesma transação (`test/integration/wagering/process-transaction.test.ts:242`, `wallet/create-wallet.test.ts:191`) |

## Requisitos por seção

| Seção | | Evidência |
|---|---|---|
| §2 autenticação | ✅ | Não implementada, documentada com desenho Keycloak (ARCHITECTURE §11); ponto de extensão `ProviderIdentityPort` + `NoopProviderAuthGuard` (`src/auth/`), health aberto (`test/unit/auth/noop-provider-auth.guard.test.ts`) |
| §4 stack / migrations reversíveis | ✅ | Bun, TS estrito, NestJS 12, PostgreSQL, MikroORM 7, SQS via LocalStack; `test/integration/schema/migration-cycle.test.ts` up → down → up |
| §5.1–5.4 | ✅ | ver eliminatórias |
| §5.5 ledger sem update/delete | ✅ | trigger + grants (acima) |
| §5.6 sem lock global | ✅ | lock por linha `SELECT … FOR NO KEY UPDATE` da wallet (`wallet/infrastructure/wallet.repository.ts`) |
| §5.7 sem read→calculate→update sem controle | ✅ | lock da wallet + `UPDATE … WHERE version = :expected` (mesmo repositório) |
| §5.8 múltiplas instâncias | ✅ | suíte multi-instância |
| §5.9 garantias no schema | ✅ | CHECKs, UNIQUEs, índice parcial, 4 triggers de imutabilidade e constraint trigger diferida wallet ↔ ledger (`0001_init.ts`; ARCHITECTURE §7 mapeia garantia → constraint); 75 testes em `test/integration/schema` |
| §6.0 construtor privado, factories, `rehydrate` sem validação | ✅ | `wallet.ts:47,63,105`, `wallet-ledger-entry.ts:34,48,54`, `wager-transaction.ts:32,64,100`, `money.ts:22,29,47`, `inbox-message.ts:27,35,55`, `outbox-message.ts:38,53,72` |
| §6.1 Money | ✅ | `test/unit/shared/money/money.test.ts` (escala, NaN/Infinity/notação científica, sem arredondamento 0.10 + 0.20, BRL×USD) |
| §6.2 Wallet: `version` começa em 1 e só muda com o saldo | ✅ | `wallet.ts:58-83,159-163`; `test/unit/wallet/wallet.test.ts`. **Correção desta fase**: a reconciliação marcava `VERSION_GAP` em wallet aberta com 0.00 (ver "Correções") |
| §6.3 WagerTransaction e terminais | ✅ | tabela de transições `transaction-status.ts`; `test/unit/wagering/transaction-transitions.test.ts`; OPENING recusado na API e na fila (`http-contract`, `consumer-processing` → DLQ) |
| §6.4 lançamento estruturalmente imutável | ✅ | só campos `readonly`, `Object.freeze` (`wallet-ledger-entry.ts:35-45`), `create` valida aritmética; LOSS e REJECTED sem lançamento (`process-transaction.test.ts:105,172`) |
| §6.5 inbox/outbox na mesma transação | ✅ | `process-transaction.test.ts:239` (atomicidade com falha injetada), `create-wallet` (mesmo `xmin`) |
| §7 regras 1–9 | ✅ | 1: `ck_wager_transactions_reversal_reference` + `wager-transaction.test.ts`; 2–5: `test/integration/reversal/reversal-rules.test.ts` (mismatch de rodada/player/wallet/moeda/valor, kind não permitido, reversão única) + matriz em `test/unit/wagering/reversal-policy.test.ts`; 6: `process-transaction.test.ts:105`; 7: `idempotency.test.ts:35` (replay com o saldo da 1ª vez); 8: `pending-reference.test.ts:56`; 9: `reversal-rules.test.ts:132` (`REVERSAL_INSUFFICIENT_FUNDS` ≠ `INSUFFICIENT_FUNDS`) |
| §7.1 fora de ordem | ✅ | reprocessador com backoff, TTL 30 min / 12 tentativas justificados (ARCHITECTURE §8); `pending-reference.test.ts:153,182` (expiração → `REFERENCE_NOT_FOUND` + evento), `multi-instance/07-early-reversals.test.ts` |
| §7.2 failureCode | ✅ | `shared/failure-code.ts` com classe/retryable/persistido; tabela no ARCHITECTURE §9 |
| §8 cenário 100 / 80 / 80 | ✅ | `wagering-concurrency.test.ts` e `multi-instance/02-competing-bets.test.ts` (×20, APIs diferentes): 1 PROCESSED, 1 `INSUFFICIENT_FUNDS`, saldo 20.00, 1 DEBIT, reenvio sem novo lançamento |
| §9 endpoints e formato | ✅ | `wallet/http/wallet.controller.ts` (POST /wallets, GET, ledger com cursor opaco, reconciliação), `wagering/http/wagering.controller.ts` (POST/GET transações, consulta por provider), `health/health.controller.ts`; corpo de sucesso e de erro uniformes |
| §9 `Idempotency-Key` obrigatório | ✅ | 400 `MISSING_IDEMPOTENCY_KEY` (`wagering.dto.ts`, `http-contract.test.ts`) |
| §9 status distintos e consistentes | ✅ | 201/200 · 202 · 422 · 400 · 409 · 404 · 503 + `Retry-After` · 500 (`shared/http/failure-http-status.ts`, ARCHITECTURE §9) |
| §9 reconciliação não corrige | ✅ | transação `REPEATABLE READ` read-only; `reconciliation.test.ts` "flags a forced mismatch, counts it in the metric and never corrects the balance" |
| §10 consumidor | ✅ | mesmo use case (`wager-consumer.worker.ts`), inbox `(consumerName, messageId)`, ack após commit, negócio/transitório/permanente, `maxReceiveCount` 5 → DLQ, SIGTERM devolve visibilidade, redelivery sem duplicar — `test/integration/sqs/*` e `multi-instance/04,05`. ⚠️ queda de PG > ~15–30 s manda mensagens válidas à DLQ (registrado no ARCHITECTURE §14) |
| §11 eventos mínimos, envelope abstrato, `MoneyProps` | ✅ | `shared/events/integration-event.ts` (abstrata) + 4 subclasses com `eventType`/`version` no tipo; `test/unit/events/*` |
| §11 crash do publisher | ✅ | `outbox-recovery.test.ts:37` (morte depois de publicar e antes do commit), `:77` (2 publishers, 500 eventos), `multi-instance/06-publisher-killed.test.ts` |
| §12 logs, redaction, métricas, health | ✅ | `docs/observabilidade.md`; `structured-logs.test.ts`, `metrics.test.ts`, `health.test.ts`. **Endurecimento desta fase**: redaction de `detail`/`params` de erros do banco |
| §13 testes listados | ✅ | unidade (Money, Wallet, regras por kind, conflito de moeda, payload divergente `payload-hash.test.ts:95`); integração (migrations/constraints, atomicidade, inbox/redelivery, publishers concorrentes, retry/DLQ, reinício); concorrência 1–8 (`multi-instance/01…08`). Mapeamento no ARCHITECTURE §13 |
| §14 diferencial: teste de carga | ✅ | `bun run test:load` + `LOAD_TEST.md` (F16). ⚠️ execução de referência fora do Compose (ver pendências) |

## Qualidade

| Item | | Evidência |
|---|---|---|
| Nenhum arquivo de `src/` acima de 500 linhas | ✅ | `find src -name '*.ts' -exec wc -l {} + \| awk '$1 > 500 && $2 != "total"'` → vazio; o maior é `wagering/domain/wager-transaction.ts` (371, maior parte JSDoc) |
| Imports no topo | ✅ | varredura de `src/`, `test/`, `scripts/`, `migrations/`: nenhum `import` depois de código, nenhum `require(`/`await import(` |
| Domínio sem Nest/MikroORM | ✅ | nenhum import de `@nestjs`/`@mikro-orm` em `src/**/domain`, `shared/money`, `shared/events`, `messaging/{inbox,outbox}` (entidades) |
| Sem `any` / `@ts-ignore` | ✅ | grep vazio; Biome com `noExplicitAny` como erro |
| typecheck, lint, suítes, 3× concorrência | ✅ | ver "Resultados" |
| README seguido do zero | ⚠️ | refeito fora do Docker, todos os exemplos conferidos (ver "Resultados"); `docker compose up` pendente no Mac |
| Documentação pt-BR sem contradição | ✅ | portas (8082 no host → 8080 no container), defaults de env, nomes de constraints/triggers e comandos conferidos. **Corrigido nesta fase**: ordem dos eventos entre lotes (ARCHITECTURE §10), `CLAUDE.md` com a porta antiga, comentário deslocado em `env.schema.ts` |

## Correções feitas nesta fase

1. **Reconciliação acusava divergência em wallet aberta com 0.00** (achado do revisor, reproduzido): sem
   lançamento de abertura, a 1ª movimentação gera `walletVersion = 2`, e `checkLedgerChain` exigia 1 → `VERSION_GAP`,
   `consistent: false`, log `warn` e `reconciliation_mismatches_total++` com o saldo correto. Corrigido em
   `src/wallet/application/ledger-chain-check.ts` (primeira versão 1 ou 2, sempre partindo de saldo 0 — o
   encadeamento continua pegando um lançamento perdido). Testes novos: 3 de unidade
   (`ledger-chain-check.test.ts`) e 1 de integração (`reconciliation.test.ts`: abre com 0.00 → WIN → BET →
   `consistent: true`, métrica inalterada). Mesma regra aplicada ao `assertLedgerInvariant` (`test/support`) e à
   verificação do teste de carga. Interpretação 21 no ARCHITECTURE e na ESPECIFICACAO.
2. **Redaction de erros do banco**: `detail`, `params` e `parameters` entram na lista (o `detail` do PostgreSQL
   traz a linha recusada, com valores). Teste novo em `test/unit/shared/observability/logger.test.ts` (falha sem a
   correção).
3. **Documentação**: ARCHITECTURE §10 dizia que a ordem por wallet "se mantém no FIFO" — vale dentro do lote; entre
   lotes é melhor esforço (vários publishers / reagendamento) e o consumidor usa `walletVersion`. §14 ganhou a janela
   de indisponibilidade antes da DLQ, o redrive fora da métrica e o `TRUNCATE` do dono. `CLAUDE.md` com a porta do
   nginx no host (8082). JSDoc de `SQS_VISIBILITY_TIMEOUT_SECONDS`/`SQS_MAX_RECEIVE_COUNT` (espelhos do init da fila).

## Achados avaliados e não alterados

- **`TRUNCATE` do ledger pelo dono**: um trigger `BEFORE TRUNCATE` exigiria migration nova e quebraria a limpeza dos
  testes (que usam o `migrator`); o `app` não tem o privilégio. Registrado como limitação.
- **Mensagens válidas na DLQ após queda longa do PG**: mudar `maxReceiveCount`/backoff é decisão operacional, não
  correção — documentado com o ajuste recomendado.
- **Timeout do cliente SQS**: o publisher já usa `AbortSignal.timeout` de 10 s por chamada (`sqs-event-publisher.ts`),
  então SQS travado não segura os locks da outbox indefinidamente.

## Resultados dos critérios de aceite

Ambiente: container Linux de 2 vCPU, PostgreSQL 16.15 nativo (`:5433` de teste, `max_connections=300`) + `moto`
5.2.3 (`:4567`) com `docker/postgres-init.sql` e `docker/localstack-init.sh`.

- `bun test test/unit` → **735 pass / 0 fail** (731 + 4 novos).
- `bun run test:integration` → **277 pass / 0 fail** (276 + 1 novo).
- `bun run test:concurrency` **3× seguidas** → 14 pass / 0 fail em cada rodada (127 s, 126 s, 124 s).
- README do zero, fora do Docker: cópia limpa → `bun install` → `cp .env.example .env` → `bun run migrate:up` →
  `bun run start` na 8082 → bloco "Exemplos de ponta a ponta" do README executado como está, todas as respostas
  esperadas (201/409/200 replay/409/422/202 → resolvido, reconciliação `consistent: true`, fila e DLQ).
- `bun run typecheck` limpo; `bun run lint` → `No fixes applied`.
- `find src -name '*.ts' -exec wc -l {} + | awk '$1 > 500 && $2 != "total"'` → vazio.

## Pendências (fora do alcance deste ambiente)

- **Wesley, no Mac**: `docker compose down -v && docker compose up -d --build`, `bun run infra:test:down &&
  bun run infra:test:up`, `bun run test:integration && bun run test:concurrency && bun test test/unit` e
  `LOG_LEVEL=warn docker compose up -d --build && bun run test:load` (anexar os números ao `LOAD_TEST.md`). Nenhuma
  fase pôde rodar os critérios com Docker/LocalStack/nginx de verdade.
