# F03 — Domínio: Wallet e WalletLedgerEntry ★

## Objetivo
Aggregate root `Wallet` cuja **única** forma de alterar saldo produz o lançamento de ledger correspondente — saldo e ledger não têm como divergir no domínio.

## Ler
- `ESPECIFICACAO.md` §3.2, §3.5; `DESAFIO.md` §6.2 e §6.4.

## Entregáveis
- `src/wallet/domain/ledger-direction.ts` — `enum LedgerDirection { Debit = "DEBIT", Credit = "CREDIT" }`.
- `src/wallet/domain/wallet-ledger-entry.ts`:
  - campos todos `readonly`: `id, walletId, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion, createdAt`;
  - `create(props)` valida: `money.isPositive()`, mesma moeda nos três `Money`, `balanceAfter` não negativo, aritmética `before ± money === after` → senão `InvalidLedgerEntryError`;
  - `rehydrate(state)` sem validação de regras; `isBalanced()`;
  - instância congelada (`Object.freeze`).
- `src/wallet/domain/wallet.ts`:
  - `open({ id, playerId, initialBalance, openingTransactionId?, at })` → retorna `{ wallet, openingEntry?: WalletLedgerEntry }`; `version = 1`; se `initialBalance` > 0 exige `openingTransactionId` e gera o lançamento CREDIT com `walletVersion = 1`, `balanceBefore = 0`;
  - `rehydrate(state)`;
  - `debit(transactionId, money, at): WalletLedgerEntry` — lança `InsufficientFundsError` se `balance < money`, `CurrencyMismatchError` se moeda difere; incrementa `version`, atualiza `updatedAt`;
  - `credit(transactionId, money, at): WalletLedgerEntry`;
  - `money` precisa ser positivo nas duas operações;
  - getters `balance`, `version`, `updatedAt`; nada de setter público.
- `src/wallet/domain/wallet.errors.ts` — `InsufficientFundsError` (code `INSUFFICIENT_FUNDS`), `InvalidLedgerEntryError`, `InvalidWalletOperationError`.
- `version` é `number` (contador, não dinheiro) — permitido; documentar no JSDoc.

## Testes (`test/unit/wallet/**`)
- `open` com zero: version 1, saldo 0, sem lançamento.
- `open` com 1000.00: version 1, lançamento CREDIT 0 → 1000.00, walletVersion 1.
- `debit` OK: saldo, version+1, lançamento balanceado.
- `debit` exato até zero permitido; `debit` acima do saldo lança e **não altera** saldo/version.
- `credit` OK.
- Moeda diferente lança e não altera estado.
- Sequência de 100 operações aleatórias (gerador com seed fixo): ao final `balance == Σ lançamentos` e versões contíguas.
- `WalletLedgerEntry.create` com aritmética errada lança; entrada é imutável (tentar atribuir falha em strict mode).
- `rehydrate` reconstrói sem lançar mesmo com estado "estranho" (ex.: version 57).

## Critérios de aceite
```bash
bun test test/unit/wallet test/unit/shared
bun run typecheck && bun run lint
grep -rn "@nestjs\|@mikro-orm" src/wallet/domain && echo "FALHOU: domínio acoplado" || echo ok
```

## Fora de escopo
Persistência, HTTP, eventos (F05).
