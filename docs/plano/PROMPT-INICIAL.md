# Prompt inicial — sessão F00

Cole o bloco abaixo numa sessão nova do agente, aberta na raiz de `~/dev/jungle-backend-challenge`.

```
Você vai iniciar a implementação do desafio técnico da Jungle Gaming (Distributed Wagering Processor).
O projeto será construído inteiramente por LLM, em fases, uma fase por sessão. Esta é a sessão da fase F00.

## Contexto obrigatório (leia antes de qualquer ação, nesta ordem)
1. CLAUDE.md — regras do repositório (stack, restrições eliminatórias, idioma, regras de código, definição de pronto).
2. docs/plano/FASES.md — visão geral das fases e como elas se encadeiam.
3. docs/plano/ESPECIFICACAO.md — fonte da verdade técnica. Para a F00, foque em §2 (linha ORM) e §9 (estrutura).
4. docs/plano/PROGRESSO.md — estado atual (tudo pendente).
5. docs/plano/fases/F00-spike-esqueleto.md — o escopo exato desta sessão.
Consulte docs/plano/DESAFIO.md (enunciado original) só se precisar confirmar algo da §4 (Stack).

## Objetivo desta sessão
Provar que Bun 1.x + NestJS + MikroORM + PostgreSQL funcionam juntos e deixar o esqueleto do repositório pronto
para as próximas fases. Nenhuma regra de negócio, entidade de domínio, LocalStack ou log estruturado nesta fase.

## Como trabalhar
1. Antes de criar arquivos, verifique o ambiente: `bun --version` (precisa ser 1.x), `docker info`, e se a porta 5432 está livre.
   Se algo faltar, pare e me diga o que instalar.
2. Apresente um plano curto (arquivos que vai criar e dependências que vai instalar, com versões) e siga sem esperar aprovação,
   a menos que precise desviar da especificação.
3. Implemente os entregáveis da F00 e valide cada item da seção "Verificar especificamente":
   - DI do Nest por tipo funcionando sob Bun (sem @Inject explícito);
   - MikroORM com em.transactional() e LockMode.PESSIMISTIC_WRITE contra uma tabela de teste;
   - coluna numeric(20,2) voltando como string do driver;
   - migrate:up / migrate:down / migrate:up via script Bun (scripts/migrate.ts) se a CLI do MikroORM falhar;
   - forma de execução escolhida (bun src/main.ts ou build) registrada.
4. Rode todos os comandos de "Critérios de aceite" do arquivo da fase e corrija até passarem.
5. Atualize docs/plano/PROGRESSO.md: F00 como ✅ (ou ⛔), arquivos criados, versões das dependências,
   decisões (ex.: Biome vs ESLint, forma de execução, como as migrations rodam) e pendências para a F01.
   Atualize também a seção "Comandos" do CLAUDE.md se algum comando mudou.

## Regras que não podem ser quebradas
- Não faça commits nem rode comandos git que alterem a árvore de trabalho (commit, checkout, reset, stash, rebase).
- Documentação e comentários explicativos em português; código, nomes e mensagens de erro/log em inglês.
- Imports sempre no topo; arquivos com no máximo 500 linhas; main.ts e app.module.ts só fazem wiring.
- TypeScript strict, sem any e sem @ts-ignore.
- Não adiante trabalho de fases futuras (nada de Money, Wallet, filas, logs JSON).

## Go / no-go
Se o MikroORM não funcionar sob Bun depois de tentativas razoáveis (decorators/metadata, driver pg, migrator),
NÃO troque para TypeORM por conta própria. Registre o erro exato, o que tentou e as alternativas em PROGRESSO.md
(seção "Bloqueios / dúvidas"), marque a F00 como ⛔ e pare. A decisão é minha.

## Ao terminar, responda com
- status da fase (✅ ou ⛔);
- saída resumida de cada comando de aceite;
- árvore de arquivos criados;
- decisões tomadas e riscos percebidos para a F01;
- sugestão de mensagem de commit (eu faço o commit manualmente).
```

## Próximas fases
Para F01 em diante, use o prompt padrão de `FASES.md` trocando o número da fase.
