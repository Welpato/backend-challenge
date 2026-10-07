# F01 — Infraestrutura (Compose, LocalStack, config, logs, health)

## Objetivo
Ambiente local completo e reproduzível: PostgreSQL com roles, LocalStack com as filas FIFO e redrive, imagem da aplicação com papéis (`APP_ROLE`), configuração validada, logs JSON com correlação e health checks reais.

## Ler
- `ESPECIFICACAO.md` §2 (papéis de processo), §7 (filas), §10 (observabilidade), §9 (estrutura).

## Entregáveis
- `Dockerfile` (base `oven/bun:1`), multi-stage, roda como usuário não-root.
- `docker-compose.yml`:
  - `postgres:16` com `docker/postgres-init.sql` criando roles `migrator` e `app` (o `app` recebe grants por migration na F06);
  - `localstack` (apenas serviço `sqs`) com `docker/localstack-init.sh` criando `wager-transactions-dlq.fifo`, `wager-transactions.fifo` (VisibilityTimeout 30, RedrivePolicy `maxReceiveCount=5`, `ContentBasedDeduplication=false`) e `wallet-events.fifo`;
  - `migrate` (job one-shot);
  - `api` com `deploy.replicas: 3` + `nginx` (round-robin, `docker/nginx.conf`) exposto em `:8080`;
  - `consumer`, `outbox`, `reprocessor` (podem só iniciar e ficar idle até as fases correspondentes);
  - healthchecks em todos.
- `docker-compose.test.yml` (ou profile `test`) com PG e LocalStack em portas separadas e `tmpfs` para o banco.
- `src/config/`: schema zod de env (`DATABASE_URL`, `APP_ROLE`, `SQS_ENDPOINT`, `AWS_REGION`, filas, timeouts, `INSTANCE_ID`, `LOG_LEVEL`, flags de fault injection); falha no boot se inválido.
- `src/shared/observability/`: `nestjs-pino` (JSON), redaction de `*.money`, `*.balance*`, `*.amount`, `req.body`; `correlation.ts` com `AsyncLocalStorage` (lê `X-Correlation-Id` ou gera uuid v7, devolve no header de resposta); `metrics.module.ts` com prom-client e `GET /metrics` (só registry e métricas default por enquanto).
- `src/health/health.controller.ts`: `/health/live` (processo) e `/health/ready` (PG `SELECT 1` + SQS `GetQueueAttributes`; 503 se algum falhar ou se o app estiver em shutdown).
- `src/main.ts`: escolhe módulos pelo `APP_ROLE` (`api` sobe HTTP; workers sobem só health + o worker; `all` sobe tudo). `enableShutdownHooks()`.
- `scripts/wait-for-infra.ts` usado pelos testes de integração.

## Critérios de aceite
```bash
docker compose up -d --build
docker compose ps                          # tudo healthy
curl -s localhost:8080/health/ready        # 200, checks de postgres e sqs ok
curl -si localhost:8080/health/live | grep -i x-correlation-id
aws --endpoint-url http://localhost:4566 sqs list-queues   # 3 filas
aws --endpoint-url http://localhost:4566 sqs get-queue-attributes --queue-url <wager-transactions.fifo> --attribute-names RedrivePolicy
docker compose stop localstack && curl -s -o /dev/null -w '%{http_code}' localhost:8080/health/ready   # 503
bun run typecheck && bun run lint && bun test test/unit
```
Logs de uma requisição saem em JSON com `correlationId` e `instanceId`.

## Fora de escopo
Métricas de negócio (F14), workers reais (F11/F12/F10).

## Armadilhas
- Se FIFO + redrive para DLQ FIFO não funcionar no LocalStack, registrar e testar MiniStack antes de seguir.
- `instanceId` = hostname do container (diferencia as 3 réplicas nos logs).
