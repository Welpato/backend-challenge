# Observabilidade

Como acompanhar o Distributed Wagering Processor em execução: logs estruturados, métricas Prometheus e health
checks. Atende ao §12 do enunciado (logs com identificadores e sem dados financeiros, métricas de status,
duplicatas, retries, DLQ, conflitos de lock, outbox lag e latência; liveness e readiness separados).

## 1. Logs

JSON em uma linha por evento (pino), na saída padrão de cada processo. Toda linha tem:

| Campo | Origem |
|---|---|
| `level`, `time`, `msg`, `context` | pino / logger do Nest |
| `instanceId`, `role` | `INSTANCE_ID` (no Compose, o hostname do container) e `APP_ROLE` |
| `correlationId` | header `X-Correlation-Id` (validado) ou gerado; no SQS, atributo `correlationId` ou o `messageId`; no reprocessador, o da transação |
| `causationId`, `messageId` | SQS: o `messageId` do envelope |
| `transactionId`, `walletId`, `providerId`, `kind`, `status`, `failureCode` | acrescentados ao contexto do fluxo assim que conhecidos |
| `durationMs` | nas linhas de desfecho |

Os identificadores ficam num `AsyncLocalStorage` por fluxo (requisição HTTP, mensagem SQS, pendência do
reprocessador) e entram em **qualquer** log emitido dentro dele — inclusive os do Nest, do filtro de erros e o
`request completed` do pino-http — sem que cada chamada precise repassá-los.

### O que nunca aparece

Valores e saldos (`money`, `amount`, `balance*`, `initialBalance`, `difference`, `credits`, `debits`…), corpos de
requisição/resposta, payloads de eventos e corpos de mensagem (`payload`, `data`, `body`, `Body`, `MessageBody`) e
headers de autenticação são removidos pelo redaction do pino (`src/shared/observability/log-redaction.ts`), em até
três níveis de aninhamento. Mensagens de erro de validação descrevem só o caminho do campo, nunca o valor recebido.
O teste `test/integration/observability/structured-logs.test.ts` processa BETs de 25.00 por HTTP e pela fila com
`LOG_LEVEL=debug` e confere que nenhuma linha contém `25.00`, `1000.00`, `975.00` ou `950.00`.

### Linhas de desfecho

| `msg` | Quem | Nível | Campos próprios |
|---|---|---|---|
| `Wager transaction processed` | use case (HTTP e SQS) | info | `source`, `idempotentReplay`, `inboxDuplicate`, `durationMs` |
| `Wager transaction not processed` / `failed` | use case | warn | `failureCode` (`IDEMPOTENCY_CONFLICT`, `WALLET_NOT_FOUND`, `TRANSIENT_UNAVAILABLE`…), `durationMs`, `err` só para erros inesperados |
| `Message processed` | consumidor SQS | info | `status`, `idempotentReplay`, `inboxDuplicate`, `durationMs` |
| `Transient failure; message will be retried` | consumidor | warn | `reason`, `receiveCount`, `durationMs` |
| `Message sent to the DLQ after a permanent failure` | consumidor | warn | `reason`, `messageId`, `sqsMessageId` |
| `Returned unfinished messages to the queue` | consumidor (SIGTERM) | warn | `released` |
| `Pending reference resolved` | reprocessador | info | `outcome` (`processed`/`rejected`/`expired`/`failed`), `durationMs` |
| `Pending reference not resolved yet` | reprocessador | debug | `outcome` (`rescheduled`/`skipped`) |
| `Outbox batch processed` | publisher | info | `claimed`, `published`, `failed`, `durationMs` |
| `Outbox message keeps failing to publish` | publisher | error | `eventId`, `eventType`, `walletId`, `attempts` (> 10) |
| `Wallet reconciliation found a mismatch` | reconciliação | warn | `walletId`, `checkedEntries`, `issues` (códigos) |

Exemplo (BET pela fila):

```json
{"level":"info","time":"2026-10-08T00:12:43.994Z","instanceId":"consumer-2","role":"consumer","correlationId":"msg-123","messageId":"msg-123","causationId":"msg-123","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37","providerId":"provider-a","kind":"BET","transactionId":"01a118da-f02a-7504-8219-82971710aac0","status":"PROCESSED","context":"WagerProcessing","source":"sqs","idempotentReplay":false,"inboxDuplicate":false,"durationMs":14,"msg":"Wager transaction processed"}
```

Requisições 2xx em `/health/*` e `/metrics` só aparecem em `debug` (os probes a cada 5 s inundariam o `info`).

## 2. Métricas

`GET /metrics` em **cada** processo (formato texto do Prometheus). Toda série tem os labels `instance` e `role`.
Os contadores são por processo: o total do sistema é a soma entre instâncias (`sum without (instance)`).

| Métrica | Tipo | Labels | O que indica |
|---|---|---|---|
| `wager_transactions_total` | counter | `kind`, `status`, `failure_code`, `source` (`http`/`sqs`/`reprocessor`) | transações finalizadas por esta instância (replays fora). `status="PENDING_REFERENCE"` conta a entrada na pendência; a resolução conta de novo com `source="reprocessor"` |
| `idempotent_replays_total` | counter | `source` | operações respondidas com o resultado gravado (mesma key ou mesmo external id e payload) |
| `inbox_duplicates_total` | counter | — | mensagens SQS já processadas (redelivery/duplicata), com ack sem efeito |
| `sqs_retries_total` | counter | — | mensagens devolvidas com backoff depois de falha transitória |
| `sqs_dlq_messages_total` | counter | `reason` | mensagens enviadas à DLQ pelo consumidor (`INVALID_ENVELOPE`, `UNKNOWN_MESSAGE_TYPE`, `VALIDATION_ERROR`, `KIND_NOT_ALLOWED`, `WALLET_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT`, `INBOX_CONFLICT`). As que chegam à DLQ pelo redrive (transitórias esgotadas) aparecem em `sqs_retries_total` |
| `wallet_lock_conflicts_total` | counter | `type` (`timeout`/`deadlock`/`version`) | lock da wallet não obtido em `DB_LOCK_TIMEOUT_MS`, deadlock detectado pelo PostgreSQL, ou guarda de versão do `UPDATE` violada (bug) |
| `wallet_lock_wait_seconds` | histogram | — | tempo entre pedir e obter o `SELECT … FOR NO KEY UPDATE` da wallet |
| `processing_duration_seconds` | histogram | `source`, `kind` | duração do caso de uso inteiro (inclusive retentativa interna e falhas) |
| `outbox_pending` | gauge | — | eventos ainda não publicados |
| `outbox_lag_seconds` | gauge | — | idade do evento não publicado mais antigo |
| `outbox_messages_over_retry_threshold` | gauge | — | eventos com mais de 10 falhas de publicação (alerta; nunca são descartados) |
| `outbox_published_total` / `outbox_publish_failures_total` | counter | — | publicações e falhas (reagendadas) |
| `pending_references` | gauge | — | transações em `PENDING_REFERENCE` |
| `reconciliation_mismatches_total` | counter | — | reconciliações que encontraram divergência (nunca corrige sozinha) |

Mais as métricas padrão do processo (`process_*`, `nodejs_*`) do prom-client.

**Gauges de banco** (`outbox_*` e `pending_references`) existem só nos papéis `outbox` e `reprocessor` e são
atualizados por uma **coleta periódica leve** (uma consulta por instância a cada `METRICS_COLLECT_INTERVAL_MS`,
5 s por padrão) — o scrape nunca consulta o PostgreSQL. Em consultas, use `max` entre as instâncias (todas leem o
mesmo banco).

Os nomes, labels e buckets estão num catálogo único: `src/shared/observability/app-metrics.ts`.

## 3. Health checks

| Rota | Significado |
|---|---|
| `GET /health/live` | o processo responde (não consulta dependências) — reiniciar o container se falhar |
| `GET /health/ready` | PostgreSQL (`SELECT 1`) e SQS (`GetQueueAttributes`) alcançáveis, cada um com timeout, e o processo **não** está em shutdown. 503 com o relatório por dependência; tirar do balanceamento |

Durante o SIGTERM a readiness passa a 503 já no primeiro hook de encerramento, enquanto o consumidor termina ou
devolve as mensagens em andamento.

## 4. Diagnóstico de cenários comuns

### Hot wallet (muitas operações na mesma wallet)

- `wallet_lock_wait_seconds` com p95/p99 subindo e `processing_duration_seconds` acompanhando; o throughput daquela
  wallet fica limitado pela serialização (é o desenho: a unidade de concorrência é a wallet).
- `wallet_lock_conflicts_total{type="timeout"}` crescendo = a fila de espera passou de `DB_LOCK_TIMEOUT_MS` (3 s): o
  HTTP devolve 503 + `Retry-After` e o SQS reentrega com backoff — nada é perdido nem duplicado.
- Nos logs, filtre `walletId` e veja `durationMs` das linhas `Wager transaction processed`.
- `type="deadlock"` deve ser ~0 (a ordem de locks evita); se crescer, é regressão. `type="version"` acima de 0 é
  bug (alguém alterou a wallet sem o lock).

```promql
histogram_quantile(0.99, sum by (le) (rate(wallet_lock_wait_seconds_bucket[5m])))
sum by (type) (rate(wallet_lock_conflicts_total[5m]))
```

### DLQ crescendo

- `sqs_dlq_messages_total` por `reason`: contrato (`INVALID_ENVELOPE`, `VALIDATION_ERROR`, `KIND_NOT_ALLOWED`) →
  produtor enviando payload errado; `WALLET_NOT_FOUND` → wallet não criada antes; `IDEMPOTENCY_CONFLICT`/
  `INBOX_CONFLICT` → produtor reaproveitando key/messageId com outro conteúdo.
- `sqs_retries_total` subindo junto com mensagens na DLQ **sem** `failureReason` = falhas transitórias que
  esgotaram o `maxReceiveCount` (PostgreSQL fora por muito tempo, erro inesperado persistente). Veja os logs
  `Transient failure; message will be retried` (`reason`, `receiveCount`).
- A mensagem na DLQ tem o corpo original e os atributos `failureReason`, `originalMessageId` e `correlationId`:
  procure o `correlationId` nos logs.

### Outbox atrasada

- `outbox_lag_seconds` e `outbox_pending` crescendo: o publisher não está conseguindo publicar.
- `outbox_publish_failures_total` subindo = SQS indisponível ou recusando (logs `Some outbox messages failed to
  publish…`); a mensagem é reagendada com backoff até 5 min e nunca descartada.
- `outbox_messages_over_retry_threshold > 0` = eventos com mais de 10 falhas: investigar o `eventId` no log de erro.
- Lag crescendo sem falhas = publishers parados ou insuficientes (confira os processos `role="outbox"` e o
  `Outbox batch processed` com `durationMs`).

```promql
max(outbox_lag_seconds)
sum(rate(outbox_publish_failures_total[5m]))
```

### Referências pendentes acumulando

- `pending_references` alto e `wager_transactions_total{status="REJECTED",failure_code="REFERENCE_NOT_FOUND"}`
  subindo: provedor enviando REFUND/ROLLBACK/WIN para referências que não chegam (ou chegam por outro provider).
  Veja `Pending reference resolved` com `outcome="expired"`.

### Divergência de saldo

- `reconciliation_mismatches_total > 0` nunca deveria acontecer (o schema impede). O log `Wallet reconciliation
  found a mismatch` traz a wallet e os códigos das verificações que falharam; a reconciliação não corrige nada.
