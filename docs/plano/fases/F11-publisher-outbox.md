# F11 — Publisher da outbox

## Objetivo
Worker que publica os eventos pendentes no SQS com segurança entre múltiplos publishers e após quedas, sem perder e sem duplicar indefinidamente.

## Ler
- `ESPECIFICACAO.md` §8 (outbox); `DESAFIO.md` §11.

## Entregáveis
- `src/messaging/sqs/sqs.client.ts` — wrapper fino do `@aws-sdk/client-sqs` (endpoint LocalStack via config), com classificação de erros transitórios.
- `src/messaging/outbox/event-publisher.port.ts` + `sqs-event-publisher.ts` — `publishBatch(messages)` → `SendMessageBatch` para `wallet-events.fifo` com `MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`, atributos `eventType`, `eventVersion`, `correlationId`; retorna sucesso/falha por mensagem.
- `src/messaging/outbox/outbox-publisher.worker.ts`:
  - loop adaptativo (250ms vazio → imediato se encheu o lote);
  - por iteração, numa UoW: `claimDue(50)` com `FOR UPDATE SKIP LOCKED` → publica → `markPublished` / `scheduleRetry` → commit;
  - nunca descarta; métrica de alerta quando `attempts > 10`;
  - shutdown: termina o lote atual e para;
  - fault hook de teste `FAULT_EXIT_AFTER_PUBLISH=1` (morre depois de publicar e antes do commit).
- Métricas: `outbox_pending`, `outbox_lag_seconds`, `outbox_published_total`, `outbox_publish_failures_total`.
- `test/support/sqs.ts` — helpers para ler todas as mensagens de uma fila (drain) e criar filas isoladas por teste.

## Testes (`test/integration/outbox/**`, LocalStack real)
- Evento só aparece na fila depois do commit; transação abortada não gera evento.
- Commit → processo morre antes de publicar (rodar o worker como subprocesso com `FAULT_EXIT_AFTER_PUBLISH` ou matar antes de iniciar) → outra instância publica → evento na fila.
- Dois publishers (subprocessos) sobre 500 eventos → todos publicados; duplicatas, se houver, têm o mesmo `eventId`; nenhum evento perdido.
- SQS indisponível (parar o container do LocalStack de teste) → `attempts` cresce, nada perdido; LocalStack volta → tudo publicado.
- Consumidor de exemplo `dedupByEventId` provando que duplicata é segura.

## Critérios de aceite
```bash
bun run test:integration -- test/integration/outbox
bun test test/unit && bun run typecheck && bun run lint
```

## Fora de escopo
Consumo de `wager-transactions.fifo` (F12).
