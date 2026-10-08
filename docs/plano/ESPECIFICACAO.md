# Especificação técnica — Distributed Wagering Processor

Fonte da verdade para todas as fases. O enunciado original está em `docs/plano/DESAFIO.md` (README do desafio, cópia integral). Em caso de conflito, o enunciado vence; registre o conflito em `PROGRESSO.md`.

---

## 1. O que está sendo pedido

Um serviço financeiro distribuído — wallet + ledger imutável — que recebe operações de provedores de jogos (`BET → WIN | LOSS | REFUND | ROLLBACK`) por **HTTP e SQS**, com entrega at-least-once, e que permanece correto quando mensagens chegam **duplicadas, fora de ordem ou simultaneamente em ≥ 3 instâncias**, quando o processo morre antes/depois do commit e quando PostgreSQL/SQS ficam indisponíveis por alguns instantes.

Invariantes globais: nunca duplicar crédito ou débito, nunca perder evento confirmado, nunca permitir saldo negativo.

**Pontuação:** correção financeira 20 · concorrência 20 · idempotência 15 · mensageria e falhas 15 · modelagem 10 · testes 10 · observabilidade 5 · documentação 5. Autenticação vale 0.

**Falhas eliminatórias:** `number` para dinheiro · saldo negativo por race · débito/crédito duplicado · idempotência só em memória · correto só com uma instância · evento antes do commit · ledger não auditável · testes que mockam PostgreSQL e SQS.

---

## 2. Decisões principais

| Tema | Decisão | Justificativa (vai para o ARCHITECTURE.md) |
|---|---|---|
| Autenticação | **Não implementada.** `ProviderIdentityPort` + `NoopProviderAuthGuard` nos endpoints de provedor; health aberto; SQS é canal interno confiável, mas `providerId` continua validado pelo domínio. Documentar desenho com Keycloak (client-credentials por provedor, claim `azp` → `providerId`) | Vale 0 ponto; o enunciado aceita explicitamente |
| ORM | **MikroORM** com `em.transactional()` + lock pessimista de escrita da wallet (`SELECT … FOR NO KEY UPDATE` explícito — ver Concorrência; `LockMode.PESSIMISTIC_PARTIAL_WRITE` = `SKIP LOCKED` nos workers). *Records* do ORM ficam na infraestrutura e são convertidos para o domínio via `rehydrate` | Domínio sem tipos de ORM/Nest; é o ORM preferencial |
| Money no código | `Money` encapsula **`bigint` de centavos** + moeda. Parse estrito `^(0|[1-9]\d{0,17})\.\d{2}$` | Exato; nunca há arredondamento — o que exigiria arredondar é rejeitado |
| Money no banco | `amount NUMERIC(20,2)` + `currency CHAR(3)`, lidos como string (o driver `pg` devolve numeric como string); tipo customizado MikroORM → `Money.from` | Representação exata em colunas separadas, permitido pelo enunciado |
| Concorrência | **Lock pessimista por wallet** (`SELECT … FOR NO KEY UPDATE` — *F07, 2026-10-07*: `FOR UPDATE` conflita com o `FOR KEY SHARE` que a FK `wallet_id` toma no INSERT da transação feito antes do lock e gerava deadlock entre duas operações da mesma wallet; `FOR NO KEY UPDATE` continua exclusivo entre escritores), `READ COMMITTED`, `lock_timeout` ≈ 3s. `version` incrementada e conferida no `UPDATE … WHERE version = :expected` como guarda extra | Unidade de concorrência = `walletId`; hot wallets serializam sem tempestade de retries (optimistic degrada em hot wallet); wallets diferentes em paralelo; sem lock global |
| Ordem de locks | Insert da própria linha de idempotência → **lock da wallet** → leituras de transações relacionadas. Toda mutação de algo da wallet acontece sob o lock dela; nunca `FOR UPDATE` em outras linhas de transação | Evita deadlock entre processamento normal, reversões e reprocessador |
| Idempotência | `UNIQUE (idempotency_key)` (o header é a fonte da verdade) + `UNIQUE (provider_id, external_transaction_id)` + `payload_hash`. Insert com `ON CONFLICT DO NOTHING`; duplicatas concorrentes bloqueiam no índice único até o vencedor commitar e então leem a linha | Persistente e multi-instância: 50 apostas idênticas em paralelo → 1 débito e 49 replays |
| Resultado do replay | Persistir snapshot `balance_after_amount` + `balance_after_currency` (moeda **da wallet**) em toda transação finalizada (inclusive LOSS/REJECTED; em `CURRENCY_MISMATCH` a moeda difere da transação) | Regra 7.7: replay devolve o resultado original, **inclusive o saldo observado naquele momento** |
| Reversão única | Índice único parcial: no máximo uma REFUND/ROLLBACK `PROCESSED` por `reference_transaction_id` (mais rígido que "uma por tipo": impede REFUND + ROLLBACK da mesma BET creditarem duas vezes) | Garantido no schema; interpretação documentada |
| Wallet ↔ ledger | Constraint trigger diferida: no commit, `wallet.balance/version` deve bater com `balance_after/wallet_version` do último lançamento (ou saldo 0 sem lançamentos) | "Toda alteração de saldo tem lançamento e vice-versa" garantido no schema |
| Imutabilidade | Ledger: trigger bloqueia UPDATE/DELETE + role da aplicação só tem INSERT/SELECT. Transações: trigger bloqueia qualquer alteração após status terminal e qualquer alteração de colunas de negócio | Estados terminais e ledger imutáveis no banco |
| Eventos | Outbox transacional na mesma transação SQL; publisher pega linhas com `FOR UPDATE SKIP LOCKED`, publica, marca como publicada e commita | Se o processo morre após o commit, outra instância publica; duplicata é segura via `eventId` |
| Fora de ordem | `PENDING_REFERENCE` + `attempts`/`next_attempt_at`; reprocessador agendado com backoff exponencial (2s·2ⁿ, teto 5 min, jitter), **TTL 30 min / máx. 12 tentativas** → `REJECTED REFERENCE_NOT_FOUND` + evento | Provedores costumam entregar a referência em segundos; 30 min cobre a janela de retry+DLQ do SQS. Configurável por env |
| Papéis de processo | Uma imagem, `APP_ROLE=api|consumer|outbox|reprocessor|all` | Compose sobe 3× api (atrás de nginx) + 3× workers |

---

## 3. Modelo de domínio (`src/**/domain`, TypeScript puro)

Todas as classes: construtor `private` + factories estáticas (`create`/`from`/`open`, `rehydrate`). `rehydrate` não revalida transições.

### 3.1 Money
`from(props)`, `zero(currency)`, `add`, `subtract`, `negate`, `isZero/isPositive/isNegative`, `isLessThan`, `equals`, `toJSON(): MoneyProps`, `toString()`, `assertSameCurrency` privado (lança `CurrencyMismatchError`).
- Valores negativos podem existir internamente (`negate`, `difference` da reconciliação), mas **contratos de entrada** rejeitam negativos (`Money.fromInput` ou validação no DTO).
- Moeda: 3 letras maiúsculas (ISO-4217). O desafio roda em BRL, mas conflitos são testados com USD.
- Rejeita: `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas, menos de 2 casas (`"25"`, `"25.5"`), número JS, mais de 18 dígitos inteiros.

### 3.2 Wallet (aggregate root)
- `open({ id, playerId, initialBalance })` → `version = 1`. O crédito de abertura faz parte da criação (bate com o exemplo do enunciado: 1000.00 / version 1).
- `rehydrate(state)`.
- `debit(transactionId, money, at)` / `credit(transactionId, money, at)` retornam o novo `WalletLedgerEntry` e incrementam `version`. São a **única** forma de alterar saldo — saldo e ledger não divergem.
- Débito abaixo de zero lança `InsufficientFundsError`. Moeda diferente lança `CurrencyMismatchError`.

### 3.3 WagerTransaction
Campos do enunciado (`failureCode`, `referenceTransactionId`, `processedAt`) + `balanceAfter` (snapshot) + `attempts`/`nextAttemptAt` (referências pendentes).
- `create` valida regras por kind: REFUND/ROLLBACK exigem `referenceExternalTransactionId`; `OPENING` só via factory interna `createOpening`.
- Transições válidas:
  - `PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE`
  - `PENDING_REFERENCE → PENDING_REFERENCE (novo agendamento) | PROCESSED | REJECTED | FAILED`
  - terminal (`PROCESSED`, `REJECTED`, `FAILED`) → qualquer: `InvalidTransactionStateError` (erro de programação).
- Consultas: `isTerminal`, `affectsBalance` (false para LOSS), `requiresReference`, `matchesPayload(hash)`, `ledgerDirectionFor(reference?)`.

### 3.4 ReversalPolicy (serviço de domínio)
Valida a referência contra as regras 7.2–7.5 e devolve a direção do lançamento ou um `FailureCode`.

### 3.5 WalletLedgerEntry
Somente campos `readonly`; `create` garante `balanceBefore ± money === balanceAfter`, `money > 0`, `balanceAfter >= 0`; `isBalanced()`. Campo extra `walletVersion`.

### 3.6 Inbox, Outbox e eventos
- `InboxMessage`: `receive`, `rehydrate`, `isProcessed`, `markProcessed`.
- `OutboxMessage`: `enqueue(event)`, `rehydrate`, `isPending`, `isDue`, `markPublished`, `scheduleRetry(now)` com backoff.
- `IntegrationEvent<T>` abstrata + uma subclasse por evento (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`), com `eventType`/`version` no tipo, `static from(...)` e `toJSON()`. `data` usa apenas `MoneyProps`.

### 3.7 Regras de negócio

| Kind | Efeito | Observações |
|---|---|---|
| BET | débito | `money > 0`; sem saldo → `REJECTED INSUFFICIENT_FUNDS`; referência opcional validada como no WIN |
| WIN | crédito | referência opcional à BET da mesma rodada; se informada, é validada (e se ausente → `PENDING_REFERENCE`, regra 7.8) |
| LOSS | nenhum | PROCESSED, sem ledger, emite `WagerTransactionProcessed`; aceita `money >= 0`; referência opcional validada como no WIN |
| REFUND | crédito | referência deve ser **BET** `PROCESSED` |
| ROLLBACK | inverso da referência | referência pode ser BET (→ crédito), WIN (→ débito), REFUND (→ débito) |

Validação da referência: resolvida por `(providerId, referenceExternalTransactionId)`; mesmo provider, player, wallet, moeda e rodada; valor **igual**; não revertida antes.
- Referência em `PENDING`/`PENDING_REFERENCE` ou ainda invisível → `PENDING_REFERENCE`.
- Referência `REJECTED`/`FAILED` → `REJECTED REFERENCE_NOT_PROCESSED`.
- Reversão que deixaria saldo negativo → `REJECTED REVERSAL_INSUFFICIENT_FUNDS` (diferente de `INSUFFICIENT_FUNDS`).

### 3.8 Taxonomia de FailureCode

| Código | Classe | Persistido | Ação do provedor |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | negócio | REJECTED | desistir |
| `REVERSAL_INSUFFICIENT_FUNDS` | negócio | REJECTED | investigação operacional |
| `CURRENCY_MISMATCH` | negócio | REJECTED | corrigir payload |
| `WALLET_PLAYER_MISMATCH` | negócio | REJECTED | corrigir payload |
| `REFERENCE_NOT_FOUND` | negócio (após TTL) | REJECTED | reenviar referência e depois nova operação |
| `REFERENCE_MISMATCH` | negócio | REJECTED | corrigir payload |
| `REFERENCE_AMOUNT_MISMATCH` | negócio | REJECTED | corrigir payload |
| `REFERENCE_KIND_NOT_ALLOWED` | negócio | REJECTED | corrigir payload |
| `REFERENCE_NOT_PROCESSED` | negócio | REJECTED | desistir |
| `ALREADY_REVERSED` | negócio | REJECTED | desistir |
| `VALIDATION_ERROR`, `MISSING_IDEMPOTENCY_KEY`, `KIND_NOT_ALLOWED` | contrato | não | corrigir payload |
| `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT` | conflito | não | nova key / corrigir payload |
| `WALLET_NOT_FOUND` | não encontrado | não (sem FK) | corrigir payload |
| `WALLET_ALREADY_EXISTS` | conflito | não | usar a wallet existente *(F08: `CreateWallet`, §5)* |
| `TRANSIENT_UNAVAILABLE` | transitório | não | reenviar com a mesma key |
| `PROCESSING_FAILED` | infra permanente | FAILED | investigação operacional |

`FAILED` só é usado quando uma transação já persistida (ex.: referência pendente) esbarra repetidamente em erro não-de-negócio além do limite de tentativas.

---

## 4. Schema do banco (migration `0001_init`, com `down`)

```sql
wallets(
  id uuid PK, player_id text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  balance numeric(20,2) NOT NULL CHECK (balance >= 0),
  version bigint NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE (player_id, currency)
)

wager_transactions(
  id uuid PK,
  provider_id text NOT NULL, external_transaction_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE, payload_hash char(64) NOT NULL,
  wallet_id uuid NOT NULL REFERENCES wallets, player_id text NOT NULL,
  round_id text NOT NULL, game_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  amount numeric(20,2) NOT NULL CHECK (amount >= 0), currency char(3) NOT NULL,
  reference_external_transaction_id text NULL,
  reference_transaction_id uuid NULL REFERENCES wager_transactions,
  status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  failure_code text NULL,
  balance_after_amount numeric(20,2) NULL, balance_after_currency char(3) NULL,  -- moeda da wallet
  attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NULL,
  correlation_id text NULL,
  created_at timestamptz NOT NULL, processed_at timestamptz NULL, updated_at timestamptz NOT NULL,
  UNIQUE (provider_id, external_transaction_id),
  CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CHECK (kind NOT IN ('BET','WIN','REFUND','ROLLBACK','OPENING') OR amount > 0),
  CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CHECK (status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL),
  CHECK ((balance_after_amount IS NULL) = (balance_after_currency IS NULL))
);
CREATE UNIQUE INDEX ux_reversal_once ON wager_transactions(reference_transaction_id)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
CREATE INDEX ix_pending_ref_due ON wager_transactions(next_attempt_at) WHERE status = 'PENDING_REFERENCE';
CREATE INDEX ix_ref_lookup ON wager_transactions(provider_id, reference_external_transaction_id);
-- trigger trg_tx_immutable: rejeita UPDATE se OLD.status terminal ou se coluna de negócio mudar

wallet_ledger_entries(
  id uuid PK, wallet_id uuid NOT NULL REFERENCES wallets,
  transaction_id uuid NOT NULL REFERENCES wager_transactions,
  direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount numeric(20,2) NOT NULL CHECK (amount > 0), currency char(3) NOT NULL,
  balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0),
  balance_after  numeric(20,2) NOT NULL CHECK (balance_after  >= 0),
  wallet_version bigint NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE (transaction_id, wallet_id),
  UNIQUE (wallet_id, wallet_version),
  CHECK ((direction='CREDIT' AND balance_after = balance_before + amount)
      OR (direction='DEBIT'  AND balance_after = balance_before - amount))
);
-- trigger trg_ledger_append_only: BEFORE UPDATE OR DELETE → RAISE; REVOKE UPDATE, DELETE do role app
-- constraint trigger diferida trg_wallet_ledger_consistency em wallets e ledger (DEFERRABLE INITIALLY DEFERRED)

inbox_messages(
  consumer_name text, message_id text, payload_hash char(64) NOT NULL,
  received_at timestamptz NOT NULL, processed_at timestamptz NULL,
  PRIMARY KEY (consumer_name, message_id)
)

outbox_messages(
  id uuid PK, -- = eventId
  aggregate_id text NOT NULL, event_type text NOT NULL, event_version int NOT NULL,
  payload jsonb NOT NULL, correlation_id text NULL, occurred_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL,
  published_at timestamptz NULL, last_error text NULL
);
CREATE INDEX ix_outbox_due ON outbox_messages(next_attempt_at) WHERE published_at IS NULL;
-- trigger: payload/event_type imutáveis
```

Dois roles: `migrator` (DDL) e `app` (DML com os grants acima).

**Migration `0002_schema_hardening`** (pós-auditoria, 2026-10-08) — garantias da §6 que só o código aplicava:
- `trg_wallets_immutable` (BEFORE INSERT/UPDATE/DELETE em `wallets`): `id`, `player_id`, `currency`, `created_at` imutáveis; nasce na versão 1; saldo mudou ⇒ versão +1 exata, saldo igual ⇒ versão igual; DELETE proibido.
- `trg_ledger_entry_integrity` (constraint trigger DEFERRABLE INITIALLY DEFERRED no ledger): no COMMIT, lançamento da mesma wallet, valor e moeda da transação e na moeda da wallet; transação `PROCESSED` e não `LOSS`; BET ⇒ DEBIT, OPENING/WIN/REFUND ⇒ CREDIT, ROLLBACK ⇒ inverso do lançamento da referência; versão = anterior + 1 e `balance_before` = `balance_after` anterior (primeiro: versão 1 ou 2, a partir de 0). Erro `23514` com `constraint = 'trg_ledger_entry_integrity'`.
- `trg_inbox_immutable` (BEFORE UPDATE em `inbox_messages`): só `processed_at` muda, de NULL para um instante.

---

## 5. Use case `ProcessWagerTransaction`

Serviço de aplicação único, usado por HTTP, consumidor SQS e reprocessador. Assinatura aproximada: `execute(cmd, ctx: { source, correlationId, causationId, inbox? })`.

```
em.transactional (READ COMMITTED, lock_timeout 3s):
 1. [SQS] INSERT inbox ON CONFLICT DO NOTHING
        conflito com mesmo hash → já processada → "duplicate" (ack)
        conflito com hash diferente → erro permanente (DLQ)
 2. tx = WagerTransaction.create(cmd)  (PENDING)
    INSERT ... ON CONFLICT DO NOTHING
        conflito → carrega por idempotency_key (ou provider + externalId)
            hash diferente → IDEMPOTENCY_CONFLICT (ou EXTERNAL_ID_CONFLICT)
            igual → devolve resultado armazenado, idempotentReplay = true
 3. wallet = SELECT FOR NO KEY UPDATE           -- inexistente → WALLET_NOT_FOUND (rollback)
    confere player/moeda → REJECTED
 4. despacho por kind (BET/WIN/LOSS/REFUND/ROLLBACK) → ReversalPolicy para referências
 5. se o saldo muda: entry = wallet.debit|credit(...)
        UPDATE wallets ... WHERE id AND version = expected   (0 linhas → violação de invariante, aborta)
        INSERT do lançamento no ledger
 6. tx.markProcessed | reject | markPendingReference ; UPDATE tx (status, failure_code, snapshot de saldo)
 7. INSERT outbox: WagerTransactionProcessed | Rejected | PendingReference (+ WalletBalanceChanged se moveu)
 8. [SQS] inbox.markProcessed
commit → a constraint trigger diferida roda
```

Pós-commit: métricas + log estruturado. Erros transitórios do PG (`40001`, `40P01`, `55P03`, conexão) viram `TRANSIENT_UNAVAILABLE`; o HTTP pode tentar 1 vez internamente em deadlock antes de devolver 503.

**`CreateWallet`:** uma transação inserindo a wallet (version 1) + se `initialBalance > 0` uma transação interna `OPENING` (idempotency key `opening:{walletId}`, provider `internal`) + lançamento CREDIT + outbox `WalletBalanceChanged` e `WagerTransactionProcessed`. Violação de `(player_id, currency)` → 409 `WALLET_ALREADY_EXISTS`.

**`ReconcileWallet`:** transação `REPEATABLE READ` somente leitura; `calculated = Σcréditos − Σdébitos`, mais verificação de cadeia (`entry[n].balance_before == entry[n-1].balance_after`, versões contíguas, último lançamento == wallet). Divergência → log `warn`, `reconciliation_mismatches_total++`, `consistent:false` na resposta; nunca corrige sozinho.

---

## 6. API HTTP e mapeamento de status

Corpo de erro uniforme: `{ "error": { "code", "message", "retryable", "correlationId" } }`. Corpo de sucesso de transação: `{ transactionId, status, failureCode?, balance, idempotentReplay }`.

| Situação | Status |
|---|---|
| Transação PROCESSED (nova / replay) | 201 / 200 |
| PENDING_REFERENCE (nova ou replay) | 202 |
| Rejeição de negócio REJECTED (nova ou replay, corpo com `failureCode`) | 422 |
| Payload inválido / sem `Idempotency-Key` / OPENING submetido | 400 |
| Conflito de idempotência ou de external id; wallet duplicada | 409 |
| Wallet / transação / recurso inexistente | 404 |
| Falha transitória (PG/SQS fora, lock timeout) | 503 + `Retry-After` |
| Transação FAILED (replay) / inesperado | 500 |

Endpoints: `POST /wallets`, `GET /wallets/:id`, `GET /wallets/:id/ledger?cursor&limit` (keyset em `wallet_version`, cursor base64url opaco, `limit ≤ 200`), `POST /wagering/transactions`, `GET /wagering/transactions/:id`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId`, `POST /wallets/:id/reconciliation`, `GET /health/live`, `GET /health/ready` (PG `SELECT 1` + SQS `GetQueueAttributes`), `GET /metrics`.

**Algoritmo do payload hash:** SHA-256 hex do JSON canônico (chaves ordenadas recursivamente, sem espaços, campos opcionais ausentes omitidos) de `{providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money:{amount,currency}, referenceExternalTransactionId?}`. Header, `messageId`, `occurredAt` e `idempotencyKey` ficam fora → a mesma operação enviada por HTTP e por SQS com a mesma key é replay.

---

## 7. Consumidor SQS

- Filas criadas no init do LocalStack: `wager-transactions.fifo` (visibility 30s, redrive → `wager-transactions-dlq.fifo`, `maxReceiveCount=5`) e `wallet-events.fifo` (saída da outbox).
- Produtores (e o publisher de teste) usam `MessageGroupId = walletId` e `MessageDeduplicationId = messageId` — ordenação/dedup do broker é só otimização.
- Loop: long-poll 20s, lote de 10, mensagens de grupos diferentes em paralelo, mesmo grupo em sequência.
- Classificação:
  - sucesso / rejeição de negócio / referência pendente / duplicata de inbox / replay → **ack após o commit**;
  - transitório → sem ack, `ChangeMessageVisibility` = backoff(`ApproximateReceiveCount`), `sqs_retries_total++`; após `maxReceiveCount` o SQS move para a DLQ;
  - permanente (envelope inválido, `type` desconhecido, validação, OPENING, conflito de hash de idempotência/inbox, wallet inexistente) → envia para a DLQ explicitamente com atributo de motivo e deleta.
- **SIGTERM:** `enableShutdownHooks`; aborta o polling, espera mensagens em andamento por até 20s, o que não terminou volta com `ChangeMessageVisibility(0)`; depois fecha o ORM.
- Injeção de falha (só testes): `FAULT_EXIT_AFTER_COMMIT=1` → `process.exit` entre o commit e o `DeleteMessage`.

---

## 8. Publisher da outbox e reprocessador

**Outbox:** loop a cada 250ms (adaptativo): numa transação, `SELECT … WHERE published_at IS NULL AND next_attempt_at <= now() ORDER BY occurred_at LIMIT 50 FOR UPDATE SKIP LOCKED` → `SendMessageBatch` para `wallet-events.fifo` (`MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`) → `markPublished` nos sucessos, `scheduleRetry` nas falhas (exponencial, teto 5 min, nunca descarta; métrica de alerta quando `attempts > 10`) → commit. Morte antes do commit → lock liberado, outro publisher reenvia → duplicata segura (consumidores deduplicam por `eventId`). Métricas: `outbox_lag_seconds` (idade da mais antiga não publicada), pendentes, tentativas.

**Reprocessador:** a cada 1s, transação curta pega IDs `PENDING_REFERENCE` vencidos com `FOR UPDATE SKIP LOCKED` e empurra `next_attempt_at` (lease); depois, para cada ID, roda o caminho "resolver pendente" do use case na própria transação (lock da wallet primeiro, relê a linha, ignora se não estiver mais pendente). Não achou → `attempts++` e backoff; TTL/tentativas esgotados → `REJECTED REFERENCE_NOT_FOUND` + `WagerTransactionRejected`. Atalho opcional: ao processar BET/WIN/REFUND, setar `next_attempt_at = now()` nas pendentes que a referenciam (mesma transação).

---

## 9. Estrutura do projeto

```
src/
  main.ts                         # só bootstrap; papel via APP_ROLE
  app.module.ts
  config/                         # schema de env (zod)
  shared/
    money/ money.ts, money.errors.ts, money-props.ts
    events/ integration-event.ts, event-context.ts
    canonical-json.ts, hashing.ts, ids.ts (uuid v7), clock.ts, failure-code.ts
    observability/ logger.module.ts, metrics.module.ts, correlation.ts (AsyncLocalStorage)
    persistence/ money.type.ts, mikro-orm.config.ts, pg-errors.ts
  auth/ provider-identity.port.ts, noop-provider-auth.guard.ts
  wallet/
    domain/ wallet.ts, wallet-ledger-entry.ts, wallet.errors.ts, events/*.ts
    application/ create-wallet.ts, get-wallet.ts, get-ledger.ts, reconcile-wallet.ts, wallet.repository.port.ts
    infrastructure/ wallet.record.ts, ledger-entry.record.ts, wallet.repository.ts, ledger-cursor.ts
    http/ wallet.controller.ts, wallet.dto.ts
  wagering/
    domain/ wager-transaction.ts, transaction-status.ts, reversal-policy.ts, wagering.errors.ts, events/*.ts
    application/ process-wager-transaction.ts, kind-handlers.ts, resolve-pending-reference.ts, payload-hash.ts, ports.ts
    infrastructure/ wager-transaction.record.ts, wager-transaction.repository.ts
    http/ wagering.controller.ts, wagering.dto.ts, http-error.mapper.ts
  messaging/
    inbox/ inbox-message.ts, inbox.repository.ts
    outbox/ outbox-message.ts, outbox.repository.ts, outbox-publisher.worker.ts
    sqs/ sqs.client.ts, wager-consumer.worker.ts, message-envelope.ts, error-classifier.ts
    reprocessor/ pending-reference.worker.ts
  health/ health.controller.ts
migrations/ 0001_init.ts
test/ unit/ integration/ concurrency/ load/ support/
docker/ localstack-init.sh, nginx.conf, postgres-init.sql
docker-compose.yml  docker-compose.test.yml  Dockerfile
README.md  ARCHITECTURE.md  LOAD_TEST.md   (em português)
```

---

## 10. Observabilidade

- Logs JSON (pino) com `correlationId`, `causationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `instanceId`, `kind`, `status`, `failureCode`. **Sem** valores, saldos ou payloads completos (redaction configurado).
- Métricas (`/metrics`, prom-client): `wager_transactions_total{kind,status,failure_code,source}`, `idempotent_replays_total{source}`, `inbox_duplicates_total`, `sqs_retries_total`, `sqs_dlq_messages_total{reason}`, `wallet_lock_conflicts_total{type=timeout|deadlock|version}`, `wallet_lock_wait_seconds`, `processing_duration_seconds{source,kind}`, `outbox_lag_seconds`, `outbox_pending`, `outbox_publish_failures_total`, `pending_references`, `reconciliation_mismatches_total`.
- Health: live = processo; ready = PG + SQS alcançáveis e não em shutdown.

---

## 11. Matriz de testes

**Unidade:** Money (parse, inválidos, sem arredondamento, imutabilidade, comparação, conflito BRL×USD); Wallet (open, version, débito/crédito, saldo insuficiente, moeda); WagerTransaction (transições, terminal congelado, referência por kind, OPENING); ReversalPolicy (todas as regras de §3.7); payload hash; envelope dos eventos.

**Integração (PG + LocalStack reais):** migrations up → down → up; cada constraint/trigger dispara; atomicidade com falha injetada; inbox e redelivery; publishers concorrentes; retry e DLQ; recuperação após reinício.

**Concorrência (processos reais):**
1. Mesma BET 50× em paralelo em 3 instâncias → 1 PROCESSED, 49 replays idênticos, 1 DEBIT.
2. 100.00 BRL + 2 × 80.00 em paralelo → 1 PROCESSED, 1 REJECTED `INSUFFICIENT_FUNDS`, saldo 20.00, 1 débito; repetido 20×.
3. 50 wallets em paralelo.
4. ≥ 3 API + 3 consumidores com carga mista HTTP + SQS.
5. Consumidor morto após commit e antes do ack → sem duplicata.
6. Dois publishers da outbox (um morto no meio do lote) → todos publicados.
7. REFUND/ROLLBACK antes da BET → resolvido; e expiração → `REFERENCE_NOT_FOUND`.
8. Reinício de todos os serviços sob carga → reconciliação consistente.

Todo teste de integração/concorrência termina com `assertLedgerInvariant()`: `wallet.balance == Σ ledger` e reconciliação `consistent: true`.

---

## 12. Interpretações adotadas (documentar no ARCHITECTURE.md)

- Entrada monetária estrita com 2 casas (`"25"` é inválido).
- Reversão única por referência, de qualquer tipo.
- WIN, BET e LOSS com referência opcional; se informada, validada como no WIN (só BET, mesmo escopo, sem conferir valor) ou pendente. *(decisão de 2026-10-07)*
- WIN/BET/LOSS que referenciam uma BET já revertida (REFUND/ROLLBACK processado) são `REJECTED ALREADY_REVERSED`. *(decisão de 2026-10-07)*
- O snapshot de saldo é gravado na moeda da wallet (`balance_after_currency`), inclusive em `CURRENCY_MISMATCH`. *(decisão de 2026-10-07)*
- LOSS aceita `0.00`.
- `WALLET_NOT_FOUND` não é persistido (sem alvo de FK).
- `FAILED` apenas para transações persistidas com retries de infra esgotados.
- `PENDING` nunca fica visível após commit no fluxo síncrono (mantido no modelo pela máquina de estados).
- Mesma operação (mesmo payload hash) com outra `Idempotency-Key` mas o mesmo `(providerId, externalTransactionId)` é **replay** (§5: "igual → devolve resultado armazenado"); só payload diferente vira `EXTERNAL_ID_CONFLICT`. *(F09, 2026-10-07)*
- Resposta de transação `PENDING_REFERENCE` (nova ou replay, 202) e de replay `FAILED` (500) **sem** `balance`: não há snapshot gravado e o replay não recalcula nada. *(F09/F10, 2026-10-07)*
- Referência de outro provider nunca é encontrada (a busca é por `(providerId, referenceExternalTransactionId)`): a operação fica `PENDING_REFERENCE` e expira como `REFERENCE_NOT_FOUND`. *(F10, 2026-10-07)*
- Esgotado o TTL/tentativas, a pendência vira `REFERENCE_NOT_FOUND` mesmo que a referência exista mas continue pendente (cadeia de pendências). *(F10, 2026-10-07)*
- Wallet aberta com `0.00`: sem lançamento de abertura, o primeiro lançamento tem `walletVersion = 2`; a reconciliação aceita a cadeia começando em 1 ou 2 (sempre a partir de saldo 0). *(F17, 2026-10-08)*
- Riscos: compatibilidade Bun × Nest × MikroORM (fase 00), FIFO + redrive no LocalStack (fase 01), head-of-line blocking do FIFO por wallet (aceito — ordenação por wallet é desejada).
