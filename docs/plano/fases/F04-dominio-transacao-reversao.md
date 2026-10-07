# F04 — Domínio: WagerTransaction e ReversalPolicy ★

## Objetivo
Máquina de estados explícita da transação de aposta e as regras de referência/reversão como serviço de domínio puro e exaustivamente testado.

## Ler
- `ESPECIFICACAO.md` §3.3, §3.4, §3.7, §3.8; `DESAFIO.md` §6.3 e §7.

## Entregáveis
- `src/wagering/domain/transaction-kind.ts`, `transaction-status.ts` (enums do enunciado).
- `src/wagering/domain/wager-transaction.ts`:
  - campos do enunciado + `balanceAfter?: Money`, `attempts: number`, `nextAttemptAt?: Date`, `correlationId?`;
  - `create(props)` — nasce `PENDING`; valida: kind ≠ OPENING; REFUND/ROLLBACK exigem `referenceExternalTransactionId`; BET/WIN/REFUND/ROLLBACK exigem `money > 0`; LOSS aceita `>= 0`;
  - `createOpening({ walletId, playerId, money, at })` — interno, `providerId = "internal"`, key `opening:{walletId}`, já sai `PROCESSED`;
  - `rehydrate(state)`;
  - transições `markProcessed(referenceTransactionId, balanceAfter, at)`, `markPendingReference(nextAttemptAt)`, `scheduleNextReferenceAttempt(nextAttemptAt)` (só em `PENDING_REFERENCE`, incrementa `attempts`), `reject(code, balanceAfter, at)`, `fail(code, at)`;
  - tabela de transições declarada como constante e usada por um único `assertCanTransition(to)`; terminal → `InvalidTransactionStateError`;
  - consultas `isTerminal`, `affectsBalance`, `requiresReference`, `matchesPayload`, `ledgerDirectionFor(reference?)`.
- `src/wagering/domain/reversal-policy.ts`:
  - `evaluate(reversal, reference | undefined): { outcome: "APPLY", direction } | { outcome: "PENDING" } | { outcome: "REJECT", code }`;
  - regras: referência ausente ou `PENDING`/`PENDING_REFERENCE` → PENDING; `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`; kind permitido (REFUND→BET; ROLLBACK→BET|WIN|REFUND; WIN→BET) senão `REFERENCE_KIND_NOT_ALLOWED`; provider/player/wallet/moeda/rodada iguais senão `REFERENCE_MISMATCH`; valor igual senão `REFERENCE_AMOUNT_MISMATCH` (não se aplica a WIN); `alreadyReversed` → `ALREADY_REVERSED`;
  - direção: REFUND → CREDIT; ROLLBACK → inverso da direção da referência (BET débito → CREDIT; WIN/REFUND crédito → DEBIT).
  - O caso "reversão deixaria saldo negativo" é decidido no use case (precisa do saldo), mas o código `REVERSAL_INSUFFICIENT_FUNDS` e o helper `insufficientFundsCodeFor(kind)` ficam aqui.
- `src/wagering/domain/wagering.errors.ts` — `InvalidTransactionStateError`, `InvalidWagerTransactionError`.
- `src/wagering/domain/payload-hash.ts` — `computePayloadHash(fields)` usando o JSON canônico da F02 com exatamente os campos de §6 da especificação.

## Testes (`test/unit/wagering/**`)
- Tabela de transições: todas as combinações (from × to) — válidas passam, inválidas lançam; terminal nunca muda.
- `create` para cada kind, com/sem referência, OPENING rejeitado, valores zero.
- `ReversalPolicy`: um teste por regra e por combinação de kind (matriz REFUND/ROLLBACK/WIN × BET/WIN/LOSS/REFUND/ROLLBACK), mismatch de cada campo isoladamente, valor diferente, já revertida, referência pendente, referência rejeitada.
- `ledgerDirectionFor` para todos os kinds.
- Payload hash: ordem de chaves irrelevante; mudar qualquer campo de negócio muda o hash; `idempotencyKey`/`messageId`/`occurredAt` não entram; mesma key com payload divergente detectada por `matchesPayload`.

## Critérios de aceite
```bash
bun test test/unit
bun run typecheck && bun run lint
grep -rn "@nestjs\|@mikro-orm" src/wagering/domain && echo "FALHOU" || echo ok
```

## Fora de escopo
Uso do saldo da wallet na decisão (F09/F10), persistência.
