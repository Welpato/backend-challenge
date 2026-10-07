# F10 — Reversões, PENDING_REFERENCE e reprocessador ★

## Objetivo
REFUND e ROLLBACK com todas as regras do enunciado, tratamento de referência fora de ordem e o worker agendado que resolve pendências com backoff e TTL.

## Ler
- `ESPECIFICACAO.md` §3.4, §3.7, §3.8, §8 (reprocessador); `DESAFIO.md` §7 e §7.1.

## Entregáveis
- Handlers REFUND/ROLLBACK em `kind-handlers.ts` (ou arquivo próprio `reversal-handler.ts` se passar do limite de linhas):
  - resolve a referência por `(providerId, referenceExternalTransactionId)` **sob o lock da wallet** (sem `FOR UPDATE` na referência);
  - aplica `ReversalPolicy`; `APPLY` → débito/crédito; se débito sem saldo → `REJECTED REVERSAL_INSUFFICIENT_FUNDS`;
  - grava `referenceTransactionId`; o índice `ux_reversal_once` é a garantia final (violação → tratar como `ALREADY_REVERSED`).
  - `PENDING` → `markPendingReference(now + backoff(0))`, evento `WagerTransactionPendingReference`, HTTP 202.
- `src/wagering/application/resolve-pending-reference.ts` — dado um id: abre UoW, lock da wallet, relê a transação; se não está mais `PENDING_REFERENCE` sai; reavalia; se ainda pendente → `scheduleNextReferenceAttempt` com backoff ou, se `attempts >= MAX` ou `createdAt + TTL < now`, `reject(REFERENCE_NOT_FOUND)` + evento Rejected.
- `src/messaging/reprocessor/pending-reference.worker.ts` — loop (intervalo configurável, padrão 1s): transação curta `claimDuePendingReferences(limit, leaseMs)` → para cada id, `resolvePendingReference` em transação própria; respeita shutdown; métrica `pending_references` (gauge).
- Atalho opcional: ao processar BET/WIN/REFUND, `UPDATE … SET next_attempt_at = now()` nas pendentes que referenciam o `externalTransactionId` dela (mesma transação).
- Config: `PENDING_REFERENCE_MAX_ATTEMPTS=12`, `PENDING_REFERENCE_TTL_MS=1800000`, base e teto do backoff.
- Replay de transação ainda pendente → 202 `idempotentReplay: true`; replay depois de resolvida → resultado final.

## Testes
Integração (`test/integration/reversal/**`):
- REFUND de BET → crédito, `referenceTransactionId` preenchido; segundo REFUND (outra key) → 422 `ALREADY_REVERSED`; ROLLBACK da mesma BET depois do REFUND → 422 `ALREADY_REVERSED`.
- ROLLBACK de BET (crédito), de WIN (débito), de REFUND (débito); ROLLBACK de LOSS → `REFERENCE_KIND_NOT_ALLOWED`; REFUND de WIN → `REFERENCE_KIND_NOT_ALLOWED`.
- Mismatch de player, wallet, rodada, moeda, provider → `REFERENCE_MISMATCH`; valor diferente → `REFERENCE_AMOUNT_MISMATCH`.
- ROLLBACK de WIN sem saldo → `REVERSAL_INSUFFICIENT_FUNDS` (≠ `INSUFFICIENT_FUNDS`), auditável.
- Referência REJECTED → `REFERENCE_NOT_PROCESSED`.
- REFUND antes da BET → 202 PENDING_REFERENCE; BET chega; worker roda → REFUND PROCESSED, saldo correto, eventos na ordem.
- Expiração: TTL curto no teste → REJECTED `REFERENCE_NOT_FOUND` + evento.
- Dois reprocessadores simultâneos sobre 100 pendentes → cada uma resolvida uma vez, sem deadlock.

Concorrência:
- REFUND e BET enviados ao mesmo tempo 50× (pares diferentes) → todas resolvidas, `assertLedgerInvariant`.
- REFUND e ROLLBACK da mesma BET em paralelo → exatamente um aplicado.

## Critérios de aceite
```bash
bun run test:integration -- test/integration/reversal
bun run test:concurrency
bun test test/unit && bun run typecheck && bun run lint
```

## Fora de escopo
Consumo via SQS (F12).
