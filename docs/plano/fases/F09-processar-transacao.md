# F09 — ProcessWagerTransaction: BET, WIN, LOSS e idempotência ★

## Objetivo
O coração do sistema: o use case único (HTTP agora, SQS e reprocessador depois) com idempotência persistente, lock por wallet, replay do resultado original e outbox na mesma transação. Reversões ficam para a F10, mas o use case já nasce com o ponto de extensão.

## Ler
- `ESPECIFICACAO.md` §2, §3.7, §5 (fluxo completo), §6; `DESAFIO.md` §7, §8, §9 (Submeter transação).

## Entregáveis
- `src/wagering/application/process-wager-transaction.ts` — `execute(cmd, ctx)` seguindo o fluxo de §5 passo a passo (passo 1 da inbox fica como parâmetro opcional, implementado na F12). Retorna `ProcessResult { transaction, balance, idempotentReplay, outcome }`.
- `src/wagering/application/kind-handlers.ts` — estratégia por kind: BET (débito, `InsufficientFundsError` → `reject(INSUFFICIENT_FUNDS)`), WIN (crédito; com referência informada usa `ReversalPolicy`), LOSS (sem saldo), REFUND/ROLLBACK → por enquanto lançam `NotImplemented` (F10).
- Validações antes de processar: wallet existe (senão `WALLET_NOT_FOUND`, rollback, nada persistido); `playerId` da wallet = do comando (senão `REJECTED WALLET_PLAYER_MISMATCH`); moeda (senão `REJECTED CURRENCY_MISMATCH`).
- Snapshot `balanceAfter` gravado em toda transação finalizada (inclusive REJECTED e LOSS).
- Outbox: `WagerTransactionProcessed` | `WagerTransactionRejected` e `WalletBalanceChanged` quando o saldo muda, com `correlationId` do contexto e `causationId` = id da transação (ou `messageId` na F12).
- Replay: conflito no insert → hash igual → devolve o estado armazenado (`idempotentReplay: true`) sem tocar na wallet; hash diferente → `IDEMPOTENCY_CONFLICT` (mesma key) ou `EXTERNAL_ID_CONFLICT` (key diferente, mesmo provider+externalId).
- Retry interno único em deadlock (`40P01`) no HTTP; demais transitórios → 503.
- `src/wagering/http/wagering.controller.ts`:
  - `POST /wagering/transactions` (header `Idempotency-Key` obrigatório, máx. 200 chars; OPENING → 400 `KIND_NOT_ALLOWED`);
  - `GET /wagering/transactions/:id`;
  - `GET /providers/:providerId/wagering/transactions/:externalTransactionId`;
  - status conforme §6 (201/200/202/422/409/400/404/503/500).

## Testes
Integração (`test/integration/wagering/**`):
- BET → 201, saldo, 1 DEBIT, eventos Processed + BalanceChanged na outbox.
- BET sem saldo → 422 `INSUFFICIENT_FUNDS`, transação REJECTED persistida, nenhum lançamento, evento Rejected, sem BalanceChanged.
- WIN → crédito; LOSS → 201 PROCESSED, nenhum lançamento, evento Processed, sem BalanceChanged.
- Replay idêntico → 200 com `idempotentReplay: true` e **o mesmo saldo da primeira resposta** mesmo depois de outras operações na wallet.
- Replay de REJECTED → 422 com `idempotentReplay: true`.
- Mesma key, payload diferente → 409 `IDEMPOTENCY_CONFLICT`; key diferente mesmo externalId → 409 `EXTERNAL_ID_CONFLICT`.
- Sem header → 400; OPENING → 400; wallet inexistente → 404; moeda USD em wallet BRL → 422 `CURRENCY_MISMATCH`.
- Atomicidade: fault hook falha no insert da outbox → nenhum efeito (wallet, ledger, transação).

Concorrência (`test/concurrency/single-process/**`, uma instância, pool de conexões real):
- Mesma BET 50× em paralelo → 1 PROCESSED + 49 replays com corpo idêntico, 1 DEBIT.
- 100.00 + 2 × 80.00 em paralelo, repetido 20× → sempre 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 DEBIT.
- 200 operações mistas na mesma wallet → `assertLedgerInvariant`.
- 50 wallets em paralelo → todas consistentes.
- `test/support/invariants.ts` com `assertLedgerInvariant(walletIds)` (usado daqui em diante).

## Critérios de aceite
```bash
bun run test:integration -- test/integration/wagering
bun run test:concurrency -- test/concurrency/single-process
bun test test/unit && bun run typecheck && bun run lint
```

## Fora de escopo
REFUND/ROLLBACK e PENDING_REFERENCE (F10), SQS (F12).

## Armadilhas
- Ordem: insert da transação → lock da wallet. Nunca o contrário (ver §2 "Ordem de locks").
- O replay não pode recalcular nada; deve devolver o que está persistido.
