# F17 — Auditoria final contra o enunciado ★

## Objetivo
Revisão independente (de preferência por um agente em sessão nova que **não** implementou as fases) comparando o repositório com o enunciado item a item, antes da entrega.

## Ler
- `DESAFIO.md` inteiro, `ESPECIFICACAO.md`, `README.md`, `ARCHITECTURE.md`.

## Checklist (cada item: ✅ / ❌ com arquivo:linha ou teste que comprova)

**Eliminatórias**
- [ ] Nenhum `number`/float para dinheiro (`grep` em `src/` por `parseFloat`, `Number(`, `toFixed`, campos `amount: number`).
- [ ] Nenhum caminho que deixe saldo negativo (CHECK no banco + teste de race).
- [ ] Nenhum débito/crédito duplicado (testes 50× e redelivery).
- [ ] Idempotência 100% no banco (nenhum `Map`/`Set`/LRU usado como dedup).
- [ ] Correto com ≥ 3 instâncias (F13).
- [ ] Nenhum `SendMessage` de evento fora do publisher da outbox.
- [ ] Ledger auditável e append-only (trigger + grants + teste).
- [ ] Testes de integração/concorrência usam PG e LocalStack reais.

**Requisitos por seção do enunciado**
- [ ] §5 restrições 1–9.
- [ ] §6 modelagem: construtores privados, factories, `rehydrate` sem validação, imutabilidade estrutural do ledger, `version` começa em 1.
- [ ] §7 regras 1–9 e §7.1/§7.2 (cada uma com teste).
- [ ] §8 cenário obrigatório 100/80/80.
- [ ] §9 todos os endpoints, formato de resposta, `Idempotency-Key`, status distintos e consistentes, reconciliação não corrige.
- [ ] §10 todos os itens do consumidor.
- [ ] §11 eventos mínimos, envelope abstrato, `MoneyProps` no `data`, cenário de crash do publisher.
- [ ] §12 logs, redaction, métricas mínimas, health.
- [ ] §13 cada teste listado existe e passa.
- [ ] §2 autenticação documentada com ponto de extensão.

**Qualidade**
- [ ] Nenhum arquivo de `src/` acima de 500 linhas; imports no topo.
- [ ] Domínio sem dependência de Nest/MikroORM.
- [ ] `bun run typecheck`, `lint`, todas as suítes verdes, 3 execuções seguidas da concorrência sem flakiness.
- [ ] README seguido do zero funciona.
- [ ] Documentação em pt-BR, sem contradição com o código.

## Entregáveis
- `docs/auditoria-final.md` (pt-BR) com o checklist preenchido e a lista de correções.
- Correções pequenas podem ser feitas na mesma sessão; correções grandes viram itens no `PROGRESSO.md` para uma sessão dedicada.

## Critérios de aceite
```bash
docker compose down -v && docker compose up -d --build
bun run test:integration && bun run test:concurrency && bun test test/unit
bun run typecheck && bun run lint
find src -name '*.ts' -exec wc -l {} + | awk '$1 > 500 && $2 != "total"'   # vazio
```
Checklist 100% ✅ ou com justificativa registrada no ARCHITECTURE (limitações).
