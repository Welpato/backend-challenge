# F13 — Suíte de concorrência multi-instância e recuperação ★

## Objetivo
Provar com **processos reais** (não mocks sequenciais) os 8 cenários de concorrência obrigatórios, com ≥ 3 instâncias de API e de consumidor ao mesmo tempo, e reinício com consistência comprovada.

## Ler
- `ESPECIFICACAO.md` §11; `DESAFIO.md` §8 e §13 (Concorrência).

## Entregáveis
- `test/support/cluster.ts` — sobe N processos `bun src/main.ts` com `APP_ROLE` e portas diferentes contra o PG/LocalStack de teste, espera `/health/ready`, expõe `kill(signal)`, `restart()`, coleta de logs por instância; derruba tudo no `afterAll`.
- `test/support/load-client.ts` — dispara requisições distribuídas entre as instâncias (round-robin + aleatório), com barreira para largada simultânea.
- `test/concurrency/multi-instance/*.test.ts`, um arquivo por cenário:
  1. mesma BET 50× distribuída em 3 APIs → 1 débito, 49 replays idênticos;
  2. 100.00 + 2 × 80.00 em APIs diferentes, 20 repetições → resultado exato do enunciado sempre;
  3. 50 wallets em paralelo, 20 operações cada, 3 APIs → todas consistentes;
  4. 3 APIs + 3 consumidores + 2 publishers + 2 reprocessadores com carga mista HTTP e fila (incluindo duplicatas e reversões) → invariantes;
  5. consumidor morto após commit e antes do ack (fault hook) → sem duplicata após redelivery;
  6. dois publishers, um morto (`SIGKILL`) no meio → todos os eventos publicados;
  7. REFUND/ROLLBACK antes da referência, enviados por instâncias diferentes → resolvidos;
  8. `SIGKILL` em todos os processos no meio da carga → reinício → reconciliação `consistent: true` para todas as wallets, nenhuma mensagem perdida (fila vazia + DLQ vazia, exceto as permanentes esperadas), outbox zerada.
- Todos terminam com `assertLedgerInvariant` + chamada HTTP de reconciliação.
- Script `bun run test:concurrency` roda a suíte completa; documentar duração esperada.

## Determinismo
- Seeds fixos para geradores; sem `sleep` arbitrário — esperar por condição (poll com timeout) em vez de tempo.
- Rodar a suíte 3× seguidas sem falha antes de marcar a fase como concluída.

## Critérios de aceite
```bash
for i in 1 2 3; do bun run test:concurrency || exit 1; done
bun run test:integration && bun test test/unit
bun run typecheck && bun run lint
```
Registrar em `PROGRESSO.md` a duração e qualquer flakiness observada.

## Fora de escopo
Medição de performance (F16).
