# F15 — Documentação em português (README e ARCHITECTURE)

## Objetivo
Entregar a documentação avaliada (5 pontos, mas é o que o avaliador lê primeiro e a base da apresentação). **Tudo em português (pt-BR)**, tom técnico, direto, com decisões justificadas e limitações honestas.

## Ler
- `ESPECIFICACAO.md` inteira, `PROGRESSO.md` (seção Decisões), `DESAFIO.md` §2, §4, §14.

## Entregáveis

### `README.md`
1. O que é o projeto (3–4 linhas).
2. Pré-requisitos (Docker, Bun versão).
3. Subir tudo: `docker compose up -d --build`; URLs (API via nginx, LocalStack, métricas).
4. Comandos: migrations, dev, testes de unidade/integração/concorrência/carga, lint/typecheck.
5. Exemplos `curl` de ponta a ponta: criar wallet, BET, replay, conflito, WIN, REFUND fora de ordem, reconciliação, ledger paginado, enviar mensagem para a fila.
6. Tabela de status HTTP e `failureCode` (resumo, com link para o ARCHITECTURE).
7. Estrutura de pastas.
8. Como verificar as invariantes manualmente.

### `ARCHITECTURE.md`
1. Visão geral e diagrama (Mermaid) dos componentes: API ×3, consumidor, publisher, reprocessador, PG, filas.
2. Modelo de domínio: agregados, invariantes, **tabela de transições de estado** da `WagerTransaction`.
3. `Money`: representação (bigint de centavos), formato de entrada estrito, mapeamento no banco, por que nunca arredonda.
4. Escolha do ORM (MikroORM) e estratégia transacional (UoW, `READ COMMITTED`, `lock_timeout`).
5. **Concorrência**: por que lock pessimista por wallet (vs. optimistic com retry e update condicionado), ordem de locks e prevenção de deadlock, comportamento em hot wallet, por que não há lock global.
6. **Idempotência**: header como fonte da verdade, unicidades, algoritmo do payload hash (campos exatos, JSON canônico, SHA-256), replay com saldo original, conflito vs. replay.
7. **Schema como última linha de defesa**: tabela "garantia → constraint/trigger".
8. Reversões e referências fora de ordem: regras, interpretação "uma reversão por referência", backoff, TTL 30 min / 12 tentativas e justificativa.
9. Taxonomia de `failureCode` com ação recomendada ao provedor; mapeamento de status HTTP.
10. Mensageria: inbox, outbox (`SKIP LOCKED`, at-least-once, dedup por `eventId`), classificação de erros, retry/backoff, DLQ, SIGTERM; papel do FIFO como otimização.
11. Autenticação: decisão de não implementar, ponto de extensão no código e desenho com Keycloak.
12. Observabilidade (resumo + link para `docs/observabilidade.md`).
13. Estratégia de testes: o que cada suíte prova, mapeado para §13 do enunciado.
14. **Trade-offs e limitações** (honestas): throughput de hot wallet limitado por serialização, head-of-line do FIFO, reversão parcial fora de escopo, sem double-entry, sem auth, etc.
15. Interpretações adotadas (lista de §12 da especificação + decisões do `PROGRESSO.md`).

### Também
- Revisar comentários de código: JSDoc em pt-BR nas regras de negócio principais (Money, Wallet, ReversalPolicy, use case, workers).

## Critérios de aceite
- Seguir o README do zero numa máquina limpa (ou num diretório recém-clonado) funciona sem passos ocultos — o agente deve executar os comandos documentados e confirmar.
- Todos os `curl` do README funcionam como escritos.
- Cada item da tabela de avaliação do enunciado (§14) tem seção correspondente no ARCHITECTURE.
- Nenhuma afirmação no ARCHITECTURE contradiz o código (conferir constraints citadas contra a migration).

## Fora de escopo
LOAD_TEST.md (F16).
