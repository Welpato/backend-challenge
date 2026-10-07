# F12 — Consumidor SQS: inbox, retry, DLQ e SIGTERM ★

## Objetivo
Entrada assíncrona reutilizando **o mesmo use case** do HTTP, com deduplicação por inbox persistente na mesma transação, ack só após commit, classificação de erros e desligamento gracioso.

## Ler
- `ESPECIFICACAO.md` §5 (passos 1 e 8), §7; `DESAFIO.md` §10.

## Entregáveis
- `src/messaging/sqs/message-envelope.ts` — schema zod do envelope `{ messageId, type: "WagerTransactionRequested", occurredAt, data }`; `data` reaproveita o DTO de wagering + `idempotencyKey`.
- `src/messaging/sqs/error-classifier.ts` — `classify(error) → "business-done" | "transient" | "permanent"` com a tabela de §7.
- `src/messaging/sqs/wager-consumer.worker.ts`:
  - long-poll (`WaitTimeSeconds=20`, `MaxNumberOfMessages=10`, `AttributeNames=[ApproximateReceiveCount]`);
  - processa grupos diferentes em paralelo e o mesmo `MessageGroupId` em sequência;
  - chama `ProcessWagerTransaction.execute(cmd, { source: "sqs", inbox: { consumerName, messageId, payloadHash } })`; correlationId = `messageId` (ou atributo `correlationId` se vier);
  - ack (`DeleteMessage`) **somente após o commit**;
  - transitório → `ChangeMessageVisibility(backoff(receiveCount))`, `sqs_retries_total++`; após `maxReceiveCount` o redrive leva para a DLQ;
  - permanente → `SendMessage` na DLQ com atributos `failureReason` e `originalMessageId` (mesmo `MessageGroupId`) e depois `DeleteMessage`; `sqs_dlq_messages_total{reason}++`;
  - SIGTERM: para o polling (AbortController), espera in-flight até `SHUTDOWN_GRACE_MS` (20s), devolve as não concluídas com `ChangeMessageVisibility(0)`, fecha conexões; readiness passa a 503 durante o shutdown;
  - fault hook `FAULT_EXIT_AFTER_COMMIT=1` (`process.exit(137)` entre commit e ack).
- Inbox no use case: passo 1 (insert `ON CONFLICT`; mesmo hash e processada → ack sem efeito, `inbox_duplicates_total++`; hash diferente → permanente) e passo 8 (`markProcessed`).
- `scripts/send-message.ts` — utilitário para publicar mensagens de teste na fila.

## Testes (`test/integration/sqs/**`, LocalStack real, consumidor rodando como subprocesso quando envolver crash)
- BET via fila → processada, ack, inbox gravada, mesmos efeitos do HTTP.
- Mesma mensagem 2× (mesmo `messageId`, dedup do FIFO desligado ou id de dedup diferente) → 1 efeito, 2 acks, `inbox_duplicates_total = 1`.
- Mensagens diferentes com a mesma `idempotencyKey` → replay pelo use case.
- Mesma operação via HTTP e via fila → um único efeito.
- Mensagem de negócio rejeitada (sem saldo) → REJECTED, ack, não vai para DLQ.
- Envelope inválido / `type` desconhecido / OPENING / wallet inexistente → DLQ imediata com motivo.
- Transitório: derrubar PG de teste → mensagem volta com backoff; PG volta → processada uma vez. Falha permanente induzida 5× → DLQ pelo redrive.
- Worker morto depois do commit e antes do ack → redelivery → nenhum efeito duplicado.
- SIGTERM com mensagens em andamento → concluídas ou devolvidas; nenhuma perdida; reinício processa o restante.

## Critérios de aceite
```bash
bun run test:integration -- test/integration/sqs
bun run test:integration && bun run test:concurrency && bun test test/unit
bun run typecheck && bun run lint
```

## Fora de escopo
Harness multi-instância completo (F13).
