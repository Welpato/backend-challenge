# Jungle Gaming — Distributed Wagering Processor · Instruções para o agente

Este repositório implementa o desafio técnico da Jungle Gaming. **Toda a implementação é feita por LLM, uma fase por sessão.**

## Antes de qualquer coisa

1. Leia `docs/plano/ESPECIFICACAO.md` — é a fonte da verdade técnica (decisões, schema, fluxos, códigos de falha, status HTTP).
2. Leia `docs/plano/PROGRESSO.md` — o que já foi feito, decisões tomadas em fases anteriores e pendências.
3. Leia **somente** o arquivo da fase atual em `docs/plano/fases/`. Não adiante trabalho de fases futuras.
4. Se algo na especificação estiver ambíguo ou se mostrar inviável, **pare e registre** em `PROGRESSO.md` (seção "Bloqueios / dúvidas") em vez de improvisar uma regra de negócio.

## Idioma

- **Documentação em português (pt-BR)**: `README.md`, `ARCHITECTURE.md`, `LOAD_TEST.md`, tudo em `docs/`, e comentários explicativos no código (JSDoc de regras de negócio, justificativas).
- **Código em inglês**: nomes de arquivos, classes, métodos, variáveis, enums, nomes de tabelas/colunas, mensagens de log e de erro da API, nomes de testes (`describe`/`it`).

## Stack obrigatória (não trocar)

Bun 1.x (runtime, package manager e test runner — `bun test`), TypeScript `strict`, NestJS, PostgreSQL, AWS SQS via LocalStack, Docker Compose, MikroORM (fallback TypeORM só se a fase 00 registrar no-go). Prisma e outros ORMs são proibidos.

## Restrições invioláveis (falha eliminatória se violadas)

- Nunca usar `number`, `float` ou `double` para dinheiro. Dinheiro é `Money` (bigint de centavos) no domínio e `NUMERIC(20,2)` no banco, trafegando como string `"25.00"`.
- Idempotência sempre persistente no PostgreSQL. Nada de cache em memória como garantia.
- Não confiar apenas em SQS FIFO; o banco garante as invariantes.
- Nenhum evento publicado antes do commit (sempre via outbox).
- Ledger é append-only: nunca UPDATE/DELETE.
- Nenhum lock global; a unidade de concorrência é a `walletId`.
- Nenhum `read → calculate → update` sem lock da wallet.
- Tem que funcionar com **≥ 3 instâncias** simultâneas.
- Unicidade, imutabilidade e não-negatividade **no schema** (constraints, índices, triggers), não só no código.
- Testes de integração/concorrência usam PostgreSQL e LocalStack **reais**. Nunca mockar banco ou fila nesses testes.

## Regras de código

- Imports sempre no topo do arquivo (ordem: stdlib/bun → terceiros → locais). Import inline só para quebrar dependência circular, com comentário explicando.
- Arquivos pequenos e de propósito único: ~300 linhas (limite suave), **500 linhas (limite rígido)**, exceto testes e migrations.
- Um domínio por módulo. `main.ts`/`app.module.ts` só fazem wiring. Helpers compartilhados vão para `src/shared/`; nunca importar um módulo de feature a partir de outro.
- Domínio (`src/**/domain`) é TypeScript puro: sem decorators do NestJS, sem tipos do MikroORM.
- Entidades de domínio: construtor `private`, factories estáticas (`create`/`from`/`open`, `rehydrate`). `rehydrate` não revalida transições.
- Sem `any`. Sem `// @ts-ignore`. `noUncheckedIndexedAccess` ligado.
- **Não fazer commits nem rodar comandos git que alterem a árvore de trabalho.** Os commits são feitos manualmente pelo Wesley.

## Comandos (mantidos atualizados pelas fases)

```bash
docker compose up -d postgres localstack   # infraestrutura
bun run migrate:up                          # migrations
bun run dev                                 # API local (APP_ROLE=all)
bun test test/unit                          # testes de unidade
bun run test:integration                    # integração (exige compose de teste)
bun run test:concurrency                    # concorrência multi-processo
bun run typecheck && bun run lint
```

## Definição de pronto de cada fase

1. Todos os critérios de aceite do arquivo da fase passam (rode os comandos e cole o resumo do resultado em `PROGRESSO.md`).
2. `bun run typecheck` e `bun run lint` limpos.
3. Testes das fases anteriores continuam passando.
4. `PROGRESSO.md` atualizado: fase marcada, arquivos criados, decisões tomadas, pendências para a próxima fase.
