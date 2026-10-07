# F08 — Wallet: casos de uso, HTTP e mapeamento de erros

## Objetivo
Endpoints de wallet completos (criação com OPENING atômico, consulta, ledger paginado, reconciliação) e a camada HTTP comum: validação, corpo de erro uniforme, mapeamento de status e ponto de extensão de autenticação.

## Ler
- `ESPECIFICACAO.md` §2 (Autenticação), §5 (`CreateWallet`, `ReconcileWallet`), §6; `DESAFIO.md` §2 e §9 (wallet, consultas, reconciliação).

## Entregáveis
- `src/auth/provider-identity.port.ts` (`resolve(request) → { providerId } | null`) e `noop-provider-auth.guard.ts` (aceita tudo, anexa identidade nula; comentário em pt-BR explicando o desenho Keycloak). Aplicado nos controllers de wallet/wagering; **não** em `/health` nem `/metrics`.
- `src/shared/http/`: pipe de validação (zod) que devolve 400 `VALIDATION_ERROR` com detalhes dos campos; filtro global de exceções → corpo `{ error: { code, message, retryable, correlationId } }` e status conforme §6 (base para todas as fases seguintes); erros transitórios → 503 + `Retry-After: 1`.
- `src/wallet/application/`:
  - `create-wallet.ts` — numa `UnitOfWork`: `Wallet.open`, insert; se saldo inicial > 0, `WagerTransaction.createOpening`, insert, append do lançamento, outbox `WagerTransactionProcessed` + `WalletBalanceChanged`. Unique `(player_id, currency)` → 409 `WALLET_ALREADY_EXISTS`. `initialBalance` ausente = `0.00` na moeda informada (exigir `currency` no corpo nesse caso — registrar a decisão).
  - `get-wallet.ts`, `get-ledger.ts` (cursor opaco base64url de `{ v: walletVersion }`, `limit` padrão 50, máx. 200, ordem crescente; resposta `{ items, nextCursor }`).
  - `reconcile-wallet.ts` — `REPEATABLE READ` somente leitura; soma créditos − débitos em `Money` (strings do banco → `Money`), verifica cadeia; divergência → log `warn` + contador `reconciliation_mismatches_total` + `consistent: false`. Nunca corrige.
- `src/wallet/http/wallet.controller.ts` + DTOs (zod).
- Respostas no formato exato do enunciado (`balance` como `MoneyProps`, `version`).

## Testes (`test/integration/wallet/**`, app Nest real + banco real, HTTP via `fetch` ou supertest)
- Criar com 1000.00 → 201, version 1, 1 lançamento CREDIT, 1 transação OPENING PROCESSED, 2 linhas na outbox, tudo na mesma transação (forçar falha no insert da outbox via fault hook de teste → nada persistido).
- Criar com 0.00 → sem lançamento, sem OPENING.
- Duplicada → 409 `WALLET_ALREADY_EXISTS`.
- Payload inválido (`amount: 10`, `"10.5"`, moeda errada, `playerId` vazio) → 400.
- `GET` inexistente → 404 `WALLET_NOT_FOUND`.
- Ledger: 120 lançamentos inseridos (via repositório), paginação de 50 em 50 cobre tudo sem repetir; cursor inválido → 400.
- Reconciliação consistente; reconciliação inconsistente forçada (desabilitar a constraint trigger na sessão de teste com `migrator` e alterar saldo) → `consistent: false`, `difference` correto, métrica incrementada, saldo **não** corrigido.

## Critérios de aceite
```bash
bun run test:integration -- test/integration/wallet
curl -s -XPOST localhost:8080/wallets -H 'content-type: application/json' \
  -d '{"playerId":"p1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
bun test test/unit && bun run typecheck && bun run lint
```

## Fora de escopo
Endpoints de wagering (F09).
