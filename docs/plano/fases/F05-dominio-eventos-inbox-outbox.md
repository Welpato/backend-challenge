# F05 — Domínio: eventos de integração, InboxMessage e OutboxMessage

## Objetivo
Modelar os eventos como classes tipadas (envelope abstrato + subclasses) e as entidades de inbox/outbox com backoff, todas puras.

## Ler
- `ESPECIFICACAO.md` §3.6, §8; `DESAFIO.md` §6.5 e §11.

## Entregáveis
- `src/shared/events/integration-event.ts` — classe abstrata `IntegrationEvent<T>` exatamente como no enunciado (`eventType` e `version` abstratos, `toJSON()` com `occurredAt` ISO-8601, `data` congelado em profundidade).
- `src/shared/events/event-context.ts` — `{ correlationId, causationId?, occurredAt, eventIdFactory }`.
- Eventos (um arquivo por evento, `version = 1`):
  - `src/wagering/domain/events/wager-transaction-processed.ts` — `from(tx, ctx)`; data: ids, provider, externalId, kind, status, `money`, `balanceAfter` (MoneyProps), `referenceTransactionId?`;
  - `wager-transaction-rejected.ts` — inclui `failureCode`;
  - `wager-transaction-pending-reference.ts` — inclui `referenceExternalTransactionId`, `nextAttemptAt`;
  - `src/wallet/domain/events/wallet-balance-changed.ts` — `from(wallet, entry, ctx)` com os campos do enunciado.
- `src/messaging/inbox/inbox-message.ts` — `receive`, `rehydrate`, `isProcessed`, `markProcessed` (lança se já processada).
- `src/messaging/outbox/outbox-message.ts` — `enqueue(event, now)` (id = `eventId`, `payload = event.toJSON()` congelado, `nextAttemptAt = now`), `rehydrate`, `isPending`, `isDue(now)`, `markPublished(at)`, `scheduleRetry(now, error)` com backoff `min(2^attempts × 1s, 5 min)` + jitter injetável (para teste determinístico).
- `src/messaging/outbox/backoff.ts` — função pura de backoff reutilizada pelo reprocessador e pelo consumidor.

## Testes (`test/unit/messaging/**`, `test/unit/events/**`)
- `toJSON` de cada evento: formato exato do envelope, `money` como string, sem instância de `Money`, `JSON.parse(JSON.stringify(x))` igual a `x.toJSON()`.
- `eventType`/`version` vêm do tipo (não passados no call site).
- `data` imutável (tentativa de mutação falha).
- Outbox: `isDue`, `markPublished` deixa de ser pendente, `scheduleRetry` incrementa e respeita teto, jitter determinístico com seed.
- Inbox: `markProcessed` duas vezes lança.

## Critérios de aceite
```bash
bun test test/unit
bun run typecheck && bun run lint
```

## Fora de escopo
Publicação real no SQS (F11), persistência (F07).
