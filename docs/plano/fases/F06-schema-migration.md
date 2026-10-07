# F06 — Schema: migration 0001_init, constraints e triggers ★

## Objetivo
O banco como **última linha de defesa**: unicidade, imutabilidade e não-negatividade garantidas no schema (critério explícito de avaliação). Testar cada garantia com SQL direto.

## Ler
- `ESPECIFICACAO.md` §2 (linhas Reversão única, Wallet↔ledger, Imutabilidade) e §4; `DESAFIO.md` §5 item 9.

## Entregáveis
- Remover a migration de spike da F00.
- `migrations/0001_init.ts` (MikroORM `Migration`, SQL explícito em `up()` e `down()`):
  - tabelas, CHECKs, UNIQUEs e índices exatamente como em §4;
  - função + trigger `trg_ledger_append_only` (BEFORE UPDATE OR DELETE → `RAISE EXCEPTION 'ledger is append-only'`);
  - função + trigger `trg_tx_immutable` em `wager_transactions`: bloqueia UPDATE quando `OLD.status IN ('PROCESSED','REJECTED','FAILED')`; bloqueia mudança de colunas de negócio (provider, external id, key, hash, wallet, player, round, game, kind, amount, currency, reference_external) sempre; bloqueia DELETE;
  - trigger de imutabilidade em `outbox_messages` (payload, event_type, aggregate_id) e bloqueio de DELETE em `inbox_messages`;
  - **constraint trigger diferida** `trg_wallet_ledger_consistency` (`DEFERRABLE INITIALLY DEFERRED`, `AFTER INSERT OR UPDATE` em `wallets` e `AFTER INSERT` em `wallet_ledger_entries`): no commit, para a wallet afetada, se existe lançamento então `balance = balance_after` e `version = wallet_version` do lançamento de maior versão; se não existe, `balance = 0`;
  - grants: `app` com SELECT/INSERT/UPDATE em `wallets`, `wager_transactions`, `outbox_messages`, `inbox_messages`; **apenas SELECT/INSERT** em `wallet_ledger_entries`; nenhum DELETE em nenhuma tabela financeira.
- `down()` remove tudo na ordem inversa.
- Configuração: migrations rodam com `migrator`; a aplicação conecta com `app`.
- `test/support/db.ts` — helpers de integração (conexão `app` e `migrator`, truncate entre testes via `migrator`).
- Script `bun run test:integration` (sobe/usa `docker-compose.test.yml`, roda migrations, executa `test/integration`).

## Testes (`test/integration/schema/**`) — SQL direto, sem domínio
- up → down → up sem erro.
- `balance` negativo rejeitado; segunda wallet mesmo player+moeda rejeitada; moeda `"brl"` rejeitada.
- Lançamento com aritmética errada rejeitado; `amount = 0` rejeitado; UPDATE/DELETE no ledger rejeitado (mesmo como `migrator`, via trigger); como `app`, erro de permissão.
- Dois lançamentos para a mesma `(wallet_id, wallet_version)` rejeitados; dois para a mesma transação rejeitados.
- Transação: duplicata de `idempotency_key` e de `(provider, external_id)` rejeitadas; REFUND sem referência rejeitado; REJECTED sem `failure_code` rejeitado; UPDATE após PROCESSED rejeitado; mudar `amount` rejeitado.
- Segunda REFUND/ROLLBACK `PROCESSED` para a mesma referência rejeitada.
- Consistência diferida: commit com `UPDATE wallets SET balance = balance + 10` sem lançamento falha; com lançamento correto passa.

## Critérios de aceite
```bash
bun run test:integration -- test/integration/schema
bun run migrate:down && bun run migrate:up
bun run typecheck && bun run lint
```

## Fora de escopo
Repositórios e mapeamento ORM (F07).
