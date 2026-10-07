# F07 — Persistência: records, tipo Money, repositórios e unit of work

## Objetivo
Adaptadores de infraestrutura que traduzem domínio ↔ banco sem vazar ORM para o domínio, com as queries críticas (lock da wallet, insert idempotente) explícitas.

## Ler
- `ESPECIFICACAO.md` §2 (ORM, concorrência, ordem de locks, idempotência), §5; `DESAFIO.md` §4 (ORM).

## Entregáveis
- `src/shared/persistence/money.type.ts` — tipo customizado MikroORM: banco `numeric(20,2)` ↔ string; a conversão para `Money` acontece no mapper (o tipo nunca produz `number`).
- `src/shared/persistence/pg-errors.ts` — classificação de erros do PG: `23505` unique (com nome da constraint), `23514` check, `40001` serialization, `40P01` deadlock, `55P03` lock timeout, `57P01`/conexão → `TransientDatabaseError`.
- `src/shared/persistence/unit-of-work.ts` — `UnitOfWork.run(fn, { isolation, lockTimeoutMs })` sobre `em.transactional()`; seta `SET LOCAL lock_timeout`; expõe o `EntityManager` do escopo aos repositórios (via parâmetro ou ALS — escolher e registrar).
- Records (`*.record.ts`, `EntitySchema` ou decorators **apenas na infraestrutura**) para wallet, ledger entry, wager transaction, inbox, outbox.
- Mappers `toDomain`/`toRecord` usando `rehydrate`.
- Portas (interfaces) em `application/` e implementações em `infrastructure/`:
  - `WalletRepository`: `insert(wallet)`, `findById`, `findByIdForUpdate(id)` (**`LockMode.PESSIMISTIC_WRITE`**), `updateBalance(wallet, expectedVersion)` (`UPDATE … WHERE id AND version = expected`; 0 linhas → `ConcurrencyInvariantError`);
  - `LedgerRepository`: `append(entry)`, `page(walletId, afterVersion, limit)`, `aggregate(walletId)` (somas por direção em string), `chain(walletId)` (stream para verificação);
  - `WagerTransactionRepository`: `insertIfAbsent(tx)` → `{ inserted: true } | { inserted: false, existing }` via `INSERT … ON CONFLICT DO NOTHING RETURNING` e, em conflito, `SELECT` pela key **ou** pelo par provider/external id; `save(tx)` (update de status); `findById`; `findByProviderExternalId`; `findReference(providerId, refExternalId)`; `hasProcessedReversal(referenceId)`; `claimDuePendingReferences(limit, leaseMs)` (`FOR UPDATE SKIP LOCKED`);
  - `InboxRepository`: `insertIfAbsent(msg)` → `inserted | { existing }`, `markProcessed`;
  - `OutboxRepository`: `enqueue(messages[])`, `claimDue(limit)` (`FOR UPDATE SKIP LOCKED`, dentro da transação do chamador), `save(message)`, `stats()` (pendentes, idade da mais antiga).
- Conexão da aplicação com o role `app`.

## Testes (`test/integration/persistence/**`, banco real)
- Round-trip de cada agregado (domínio → banco → domínio) com `Money` exato (`"999999999999999999.99"`).
- `findByIdForUpdate` bloqueia: duas transações, a segunda espera até a primeira commitar (medir com timestamps); com `lock_timeout` baixo, a segunda recebe erro classificado como transitório.
- `updateBalance` com versão errada lança.
- `insertIfAbsent` concorrente (20 promises em conexões diferentes) com a mesma key → exatamente 1 `inserted: true`.
- `claimDue` em duas transações simultâneas retorna conjuntos disjuntos.
- Erros do PG classificados corretamente.

## Critérios de aceite
```bash
bun run test:integration -- test/integration/persistence test/integration/schema
bun test test/unit
bun run typecheck && bun run lint
grep -rn "@mikro-orm" src/*/domain src/shared/money && echo "FALHOU" || echo ok
```

## Fora de escopo
Casos de uso e HTTP.

## Armadilhas
- O Identity Map do MikroORM pode devolver entidade em cache sem reler do banco: dentro do `transactional`, use `refresh`/query explícita para a leitura com lock.
- Nunca usar `em.flush()` fora da unit of work.
