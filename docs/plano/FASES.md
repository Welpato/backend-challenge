# Plano de fases — execução por LLM

A implementação é feita **inteiramente por LLM**, uma fase por sessão. Cada fase:

- cabe numa sessão com contexto limpo (lê só `CLAUDE.md`, `ESPECIFICACAO.md`, `PROGRESSO.md` e o arquivo da fase);
- termina com algo **verificável por comando** (testes, typecheck, curl), não por "parece certo";
- deixa o repositório num estado verde para a próxima fase.

## Como iniciar uma fase (prompt padrão)

Cole no agente, trocando `NN`:

```
Você vai executar a fase NN do projeto Jungle Gaming Backend Challenge.

1. Leia CLAUDE.md, docs/plano/ESPECIFICACAO.md e docs/plano/PROGRESSO.md.
2. Leia docs/plano/fases/FNN-*.md. Implemente somente o que está nele.
3. Consulte docs/plano/DESAFIO.md apenas para as seções citadas na fase.
4. Rode todos os comandos de "Critérios de aceite" e corrija até passarem.
5. Rode também os testes das fases anteriores (bun test test/unit e, se já existirem, integração).
6. Atualize docs/plano/PROGRESSO.md: marque a fase, liste arquivos, decisões e pendências.
Não faça commits. Se encontrar ambiguidade de regra de negócio, registre em PROGRESSO.md e pare.
```

Ao final de cada fase, revise o diff e faça o commit manualmente (sugestão de mensagem: `feat(fNN): <resumo>`).

## Sessão de revisão (opcional, recomendada nas fases marcadas com ★)

Numa sessão nova, peça a outro agente:

```
Revise a fase NN contra docs/plano/ESPECIFICACAO.md e a seção "Critérios de aceite" de docs/plano/fases/FNN-*.md.
Procure especificamente: uso de number para dinheiro, read→calculate→update sem lock, eventos fora da outbox,
idempotência fora do banco, testes que mockam PG/SQS, arquivos > 500 linhas, imports fora do topo.
Liste problemas com arquivo:linha. Não corrija nada.
```

## Visão geral

| Fase | Nome | Depende de | Peso na avaliação |
|---|---|---|---|
| F00 | Spike e esqueleto (Bun + Nest + MikroORM) | — | habilita tudo |
| F01 | Infraestrutura (compose, LocalStack, config, logs, health) | F00 | observabilidade, mensageria |
| F02 | Shared kernel: `Money`, JSON canônico, hash, `FailureCode` ★ | F00 | correção financeira |
| F03 | Domínio: `Wallet` e `WalletLedgerEntry` ★ | F02 | correção financeira, modelagem |
| F04 | Domínio: `WagerTransaction` e `ReversalPolicy` ★ | F02 | correção financeira, modelagem |
| F05 | Domínio: eventos de integração, `InboxMessage`, `OutboxMessage` | F03, F04 | mensageria, modelagem |
| F06 | Schema: migration `0001_init`, constraints e triggers ★ | F01 | concorrência, correção |
| F07 | Persistência: records, tipo `Money`, repositórios, unit of work | F05, F06 | concorrência |
| F08 | Wallet: casos de uso + HTTP + mapeamento de erros | F07 | correção financeira |
| F09 | `ProcessWagerTransaction`: BET/WIN/LOSS + idempotência ★ | F08 | idempotência, concorrência |
| F10 | Reversões, `PENDING_REFERENCE` e reprocessador ★ | F09 | correção financeira |
| F11 | Publisher da outbox | F09 | mensageria |
| F12 | Consumidor SQS (inbox, retry, DLQ, SIGTERM) ★ | F10, F11 | mensageria e falhas |
| F13 | Suíte de concorrência multi-instância e recuperação ★ | F12 | concorrência, testes |
| F14 | Observabilidade completa | F12 | observabilidade |
| F15 | Documentação em português (README, ARCHITECTURE) | F13, F14 | documentação |
| F16 | Teste de carga (opcional) | F13 | diferencial |
| F17 | Auditoria final contra o enunciado ★ | todas | todas |

Ordem possível de paralelizar (se rodar mais de um agente): F03 ∥ F04 após F02; F06 ∥ F02–F05 após F01; F11 ∥ F10 após F09; F14 ∥ F13.

## Regras gerais para todas as fases

- Código em inglês, documentação e comentários explicativos em português (ver `CLAUDE.md`).
- Testes de unidade ficam em `test/unit/**`, integração em `test/integration/**`, concorrência em `test/concurrency/**`.
- Nenhuma fase pode deixar teste anterior vermelho.
- Toda decisão que não está na especificação vai para `PROGRESSO.md` → "Decisões" (será usada na F15 para o ARCHITECTURE.md).
