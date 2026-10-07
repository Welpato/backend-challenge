# F14 — Observabilidade completa

## Objetivo
Fechar os itens obrigatórios de §12 do enunciado: logs estruturados com todos os identificadores, sem dados financeiros, e o conjunto mínimo de métricas.

## Ler
- `ESPECIFICACAO.md` §10; `DESAFIO.md` §12.

## Entregáveis
- Todos os logs de processamento (HTTP, consumidor, publisher, reprocessador) com `correlationId`, `causationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `instanceId`, `kind`, `status`, `failureCode`, `durationMs`. Contexto propagado via `AsyncLocalStorage` (inclusive nos workers).
- Redaction verificada: nenhum `amount`, `balance`, corpo de requisição ou payload completo de evento em log.
- Métricas (todas com `instance` como label default):
  - `wager_transactions_total{kind,status,failure_code,source}`
  - `idempotent_replays_total{source}`, `inbox_duplicates_total`
  - `sqs_retries_total`, `sqs_dlq_messages_total{reason}`
  - `wallet_lock_conflicts_total{type=timeout|deadlock|version}`, `wallet_lock_wait_seconds` (histograma: tempo entre pedir e obter o lock)
  - `processing_duration_seconds{source,kind}` (histograma)
  - `outbox_lag_seconds`, `outbox_pending`, `outbox_publish_failures_total`
  - `pending_references`, `reconciliation_mismatches_total`
- Gauges de banco (outbox/pendentes) atualizados por coleta periódica leve, não por query a cada scrape.
- `docs/observabilidade.md` (pt-BR): lista de métricas, o que cada uma indica, exemplos de log e como diagnosticar cenários comuns (hot wallet, DLQ crescendo, outbox atrasada).
- Opcional (só se sobrar tempo): OpenTelemetry tracing e um dashboard Grafana no compose.

## Testes
- Unidade/integração: cada métrica é incrementada no cenário correspondente (ler `/metrics` e conferir).
- Teste de redaction: processar uma BET e verificar que nenhuma linha de log contém o valor `"25.00"` nem o saldo.

## Critérios de aceite
```bash
bun run test:integration -- test/integration/observability
curl -s localhost:8080/metrics | grep -E "wager_transactions_total|outbox_lag_seconds|wallet_lock_wait_seconds"
bun run typecheck && bun run lint
```

## Fora de escopo
Alertas reais.
