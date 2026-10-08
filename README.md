# Distributed Wagering Processor

Serviço financeiro distribuído do desafio técnico da Jungle Gaming: wallet com ledger imutável que processa
operações de provedores de jogos (`BET → WIN | LOSS | REFUND | ROLLBACK`) recebidas por **HTTP e SQS**, com entrega
at-least-once. Continua correto com mensagens duplicadas, fora de ordem ou simultâneas em **várias instâncias**,
com processos morrendo antes/depois do commit e com PostgreSQL/SQS indisponíveis por alguns instantes.

Stack: Bun · TypeScript estrito · NestJS · PostgreSQL 16 · MikroORM 7 · SQS (LocalStack) · Docker Compose.
Decisões, trade-offs e limitações: **[ARCHITECTURE.md](ARCHITECTURE.md)**. Métricas e logs:
**[docs/observabilidade.md](docs/observabilidade.md)**.

## Pré-requisitos

- Docker com Compose v2 (`docker compose version`).
- Bun **1.4.x** (`curl -fsSL https://bun.sh/install | bash`) — só para rodar testes, migrations e scripts fora
  do Docker. A imagem da aplicação já traz o Bun.
- `curl` e `jq` para os exemplos abaixo.

## Subir tudo

```bash
docker compose up -d --build
docker compose ps                         # postgres, localstack, migrate (exited 0), 3× api, nginx, 3× cada worker
curl -s localhost:8082/health/ready       # {"status":"ok",…,"checks":{"postgres":{"status":"up"},"sqs":{"status":"up"}}}
```

| O quê | Onde |
|---|---|
| API (nginx round-robin sobre 3 réplicas `api`) | `http://localhost:8082` (o nginx escuta na 8080 dentro do container) — outra porta: `NGINX_PORT=9090 docker compose up -d` |
| Métricas de uma réplica da API | `http://localhost:8082/metrics` (cada requisição cai numa réplica; a série tem o label `instance`) |
| Métricas de um worker | `docker compose exec outbox bun -e 'console.log(await (await fetch("http://localhost:3000/metrics")).text())'` |
| Liveness / readiness | `/health/live`, `/health/ready` (sem autenticação) |
| LocalStack (SQS) | `http://localhost:4566` — filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wallet-events.fifo` |
| PostgreSQL | `localhost:5432`, banco `wagering` (roles `migrator`/`app`; superusuário `wagering`/`wagering`) |

Uma única imagem roda todos os papéis via `APP_ROLE` (`api`, `consumer`, `outbox`, `reprocessor`, `all`). O job
`migrate` aplica as migrations como `migrator` antes dos demais. Réplicas: `API_REPLICAS`, `CONSUMER_REPLICAS`,
`OUTBOX_REPLICAS`, `REPROCESSOR_REPLICAS` (default 3). Derrubar: `docker compose down` (`-v` apaga o banco).

## Comandos

```bash
bun install
cp .env.example .env                        # app/scripts fora do Docker apontando para o compose (PG :5432, SQS :4566)

# Migrations (versionadas e reversíveis; rodam como `migrator`)
bun run migrate:up
bun run migrate:down                        # desfaz a última
bun run migrate:create <nome>               # migrations/NNNN_<nome>.ts

# App fora do Docker (lê .env; APP_ROLE=all sobe API + todos os workers num processo)
bun run dev                                 # com watch
bun run start

# Testes — integração e concorrência usam PostgreSQL e SQS reais (docker-compose.test.yml: PG :5433, LocalStack :4567)
bun run test:unit                           # = bun test test/unit (~1 s)
bun run infra:test:up                       # sobe a infra de teste (bun run infra:test:down para derrubar)
bun run test:integration                    # espera a infra, aplica migrations, roda test/integration (~80 s)
bun run test:integration -- test/integration/sqs   # um diretório/arquivo
bun run test:concurrency                    # single-process + multi-instância com processos reais (~2 min)

# Qualidade
bun run typecheck && bun run lint           # tsc --noEmit + Biome (bun run lint:fix formata)

# Mensagem de teste na fila de entrada
bun scripts/send-message.ts --wallet <walletId> --player <playerId> [--kind BET --amount 25.00 --count 2 …]
```

O teste de carga (`bun run test:load`) ainda não existe — é a fase seguinte do plano (`docs/plano/`).

## Exemplos de ponta a ponta

Contra a stack do `docker compose` (troque a porta se usou `NGINX_PORT`). Copie o bloco inteiro num terminal:
as variáveis são reaproveitadas de um exemplo para o outro.

```bash
API=http://localhost:8082
PLAYER="player-$(date +%s)"

# 1. Criar wallet com 1000.00 BRL (gera OPENING + CREDIT no ledger na mesma transação SQL) → 201
WALLET=$(curl -s -X POST $API/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}" | jq -r .id)
curl -s $API/wallets/$WALLET | jq
# {"id":"…","playerId":"player-…","balance":{"amount":"1000.00","currency":"BRL"},"version":1}

# A mesma wallet de novo → 409 WALLET_ALREADY_EXISTS
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}"

# 2. BET de 25.00 → 201 PROCESSED, saldo 975.00
op() { # op <kind> <externalId> <amount> [referenceExternalTransactionId]
  local ref=""; [ -n "${4:-}" ] && ref=",\"referenceExternalTransactionId\":\"$4\""
  echo "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$2\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"$1\",\"money\":{\"amount\":\"$3\",\"currency\":\"BRL\"}$ref}"
}
submit() { # submit <idempotency-key> <body>
  curl -s -w '  → HTTP %{http_code}\n' -X POST $API/wagering/transactions \
    -H 'content-type: application/json' -H "Idempotency-Key: $1" -d "$2"
}
submit provider-a:bet-1 "$(op BET bet-1 25.00)"
# {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}  → HTTP 201

# 3. Replay: mesma key e mesmo payload → 200, mesmo resultado, idempotentReplay: true, nenhum débito novo
submit provider-a:bet-1 "$(op BET bet-1 25.00)"

# 4. Conflito: mesma key, payload diferente → 409 IDEMPOTENCY_CONFLICT (não é replay)
submit provider-a:bet-1 "$(op BET bet-1 30.00)"

# 5. WIN de 50.00 referenciando a BET → 201, saldo 1025.00
submit provider-a:win-1 "$(op WIN win-1 50.00 bet-1)"

# 6. Rejeição de negócio: BET acima do saldo → 422 REJECTED INSUFFICIENT_FUNDS (com o saldo observado)
submit provider-a:bet-big "$(op BET bet-big 5000.00)"

# 7. REFUND fora de ordem: chega antes da BET → 202 PENDING_REFERENCE; a BET chega; o reprocessador resolve
submit provider-a:refund-2 "$(op REFUND refund-2 10.00 bet-2)"
submit provider-a:bet-2 "$(op BET bet-2 10.00)"
sleep 3
curl -s $API/providers/provider-a/wagering/transactions/refund-2 | jq '{status, referenceTransactionId}'
# {"status":"PROCESSED","referenceTransactionId":"…"}   (saldo de volta a 1025.00)

# 8. Reconciliação (somente leitura): saldo gravado × Σ ledger, cadeia de versões → consistent: true
curl -s -X POST $API/wallets/$WALLET/reconciliation | jq
# {"walletId":"…","storedBalance":{"amount":"1025.00",…},"calculatedBalance":{"amount":"1025.00",…},
#  "difference":{"amount":"0.00",…},"consistent":true,"checkedEntries":5}

# 9. Ledger paginado (keyset em wallet_version, cursor opaco)
PAGE=$(curl -s "$API/wallets/$WALLET/ledger?limit=2")
echo "$PAGE" | jq '[.items[] | {walletVersion, direction, amount: .money.amount, balanceAfter: .balanceAfter.amount}]'
curl -s "$API/wallets/$WALLET/ledger?limit=2&cursor=$(echo "$PAGE" | jq -r .nextCursor)" | jq '.items | length'
```

**Pela fila** (mesmo use case do HTTP; precisa do `bun install` e do `.env` copiado do `.env.example`):

```bash
bun scripts/send-message.ts --wallet $WALLET --player $PLAYER --external bet-sqs-1 --message-id msg-demo-1 --count 2
sleep 2
curl -s $API/providers/provider-a/wagering/transactions/bet-sqs-1 | jq '{status, balanceAfter}'
# {"status":"PROCESSED","balanceAfter":{"amount":"1000.00","currency":"BRL"}} — a 2ª cópia caiu na inbox (sem efeito)
curl -s $API/wallets/$WALLET | jq .balance            # 1000.00: um único débito de 25.00
bun scripts/send-message.ts --raw '{"messageId":"bad-1","type":"Unknown"}'   # vai para a DLQ com failureReason
```

Sem Bun no host, o mesmo envio pelo AWS CLI (credenciais `test`/`test`, região `us-east-1`):

```bash
QUEUE=$(aws --endpoint-url http://localhost:4566 sqs get-queue-url --queue-name wager-transactions.fifo --output text)
aws --endpoint-url http://localhost:4566 sqs send-message --queue-url "$QUEUE" \
  --message-group-id "$WALLET" --message-deduplication-id msg-demo-2 \
  --message-body "{\"messageId\":\"msg-demo-2\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-07-29T15:00:00.000Z\",\"data\":$(op BET bet-sqs-2 25.00 | jq -c '. + {idempotencyKey: "provider-a:bet-sqs-2"}')}"
```

## Status HTTP e `failureCode`

Corpo de erro uniforme: `{"error":{"code","message","retryable","correlationId"}}` (+ `details` em
`VALIDATION_ERROR`). Corpo de transação: `{transactionId, status, failureCode?, balance?, idempotentReplay}`.

| Situação | Status | `code` / `failureCode` | O provedor deve… |
|---|---|---|---|
| Transação processada (nova / replay) | 201 / 200 | — | seguir |
| Aceita, aguardando a referência (nova ou replay) | 202 | — (`PENDING_REFERENCE`) | aguardar o evento final ou consultar |
| Rejeição de negócio (nova ou replay) | 422 | `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH`, `REFERENCE_*`, `ALREADY_REVERSED` | não reenviar a mesma operação |
| Payload inválido / sem `Idempotency-Key` / OPENING | 400 | `VALIDATION_ERROR`, `MISSING_IDEMPOTENCY_KEY`, `KIND_NOT_ALLOWED` | corrigir o payload |
| Conflito de idempotência / external id / wallet duplicada | 409 | `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` | nova key ou corrigir |
| Wallet / transação inexistente | 404 | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` | corrigir |
| Falha transitória (PG/SQS fora, lock timeout) | 503 + `Retry-After` | `TRANSIENT_UNAVAILABLE` (`retryable: true`) | reenviar com a **mesma** key |
| Replay de transação `FAILED` / erro inesperado | 500 | `PROCESSING_FAILED` / `INTERNAL_ERROR` | investigação |

Taxonomia completa, com a ação recomendada por código: [ARCHITECTURE.md §9](ARCHITECTURE.md#9-taxonomia-de-falhas-e-status-http).

## Estrutura

```
src/
  main.ts · create-app.ts · app.module.ts      # bootstrap e wiring por papel (APP_ROLE)
  config/                                      # env validado por zod
  shared/                                      # Money, FailureCode, JSON canônico, hash, ids, clock, eventos,
                                               # http (erros), observabilidade, persistência (UoW, tipo Money, erros do PG), workers
  auth/                                        # ProviderIdentityPort + guard no-op (ponto de extensão)
  wallet/       domain/ application/ infrastructure/ http/
  wagering/     domain/ application/ infrastructure/ http/
  messaging/    inbox/ outbox/ sqs/ reprocessor/
  health/
migrations/0001_init.ts                        # schema, constraints, triggers, grants
docker/                                        # init do PostgreSQL (roles), do LocalStack (filas), nginx
scripts/                                       # migrate, test-integration, send-message, healthcheck, wait-for-infra
test/
  unit/ integration/ concurrency/{single-process,multi-instance}/ support/
docs/observabilidade.md · docs/plano/          # plano por fases, especificação e progresso
```

## Verificando as invariantes manualmente

```bash
# Reconciliação de uma wallet pela API (somente leitura; divergência → consistent:false + log + métrica)
curl -s -X POST localhost:8082/wallets/$WALLET/reconciliation | jq '{consistent, difference, checkedEntries}'

# No banco, para todas as wallets: saldo == Σ créditos − Σ débitos e último lançamento == wallet
docker compose exec postgres psql -U wagering -d wagering -c "
  select w.id, w.balance, w.version,
         coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0) as ledger,
         max(e.wallet_version) as last_version
    from wallets w left join wallet_ledger_entries e on e.wallet_id = w.id
   group by w.id
  having w.balance <> coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)
      or w.version <> coalesce(max(e.wallet_version), w.version);"     # 0 linhas = consistente

# Nenhum débito/crédito duplicado: no máximo um lançamento por transação, uma reversão por referência
docker compose exec postgres psql -U wagering -d wagering -c "
  select transaction_id, count(*) from wallet_ledger_entries group by 1 having count(*) > 1;"   # 0 linhas

# O schema recusa o que o código jamais deveria fazer (ledger append-only, saldo negativo):
docker compose exec postgres psql -U app -d wagering -c "delete from wallet_ledger_entries;"     # permission denied
docker compose exec postgres psql -U wagering -d wagering -c "update wallet_ledger_entries set amount = 1;"  # ledger is append-only
```

A suíte `bun run test:concurrency` faz tudo isso automaticamente depois de cada cenário (inclusive com `SIGKILL`
em todos os processos no meio da carga).
