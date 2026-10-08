# Teste de carga

Experimento reproduzível exposto como `bun run test:load` (diferencial opcional do §14 do enunciado). O objetivo
não é um número de RPS: é ver **onde o sistema satura, o que satura primeiro e se as invariantes continuam
valendo sob carga** — e todos os cenários terminam reconciliando 100% das wallets.

> **Execução de referência deste documento:** máquina de 2 vCPU com PostgreSQL nativo e o emulador `moto` no
> lugar do LocalStack (o ambiente de quem implementou não tem registry de imagens Docker — ver §6). Os números são
> reais, desta execução (JSON completo em [`docs/load-test/execucao-referencia-local.json`](docs/load-test/execucao-referencia-local.json)),
> mas valem **para esse ambiente**. A rodada com a stack do `docker compose` (LocalStack, nginx, imagens) ainda
> precisa ser feita no Mac e anexada aqui — ver §7.

## 1. Como rodar

```bash
LOG_LEVEL=warn docker compose up -d --build   # LOG_LEVEL=warn: uma linha info por transação pesa sob carga (F14)
bun install
bun run test:load                              # ~10 min: 4 cenários × (abertura + 5 s de aquecimento + 30 s medidos + drenagem)
```

Saída: tabela no terminal + JSON completo em `test/load/results/` (`latest.json` e um arquivo por execução; a
pasta é ignorada pelo git). Código de saída 1 se alguma reconciliação não fechar.

| Variável | Default | Para quê |
|---|---|---|
| `LOAD_TARGET` | `compose` | `compose`: stack já de pé, HTTP pelo nginx e métricas de cada container por `docker exec`. `local`: o script sobe 3 réplicas de cada papel com `bun src/main.ts` (harness da F13) contra a infra do `.env`; sem nginx, o cliente faz round-robin entre as APIs |
| `LOAD_BASE_URL` | `http://localhost:${NGINX_PORT:-8082}` | nginx no modo `compose` |
| `LOAD_SCENARIOS` | `1,2,3,4` | subconjunto |
| `LOAD_WARMUP_SECONDS` / `LOAD_DURATION_SECONDS` | `5` / `30` | aquecimento descartado / janela medida, por cenário |
| `LOAD_DRAIN_TIMEOUT_SECONDS` | `300` | espera máxima da fila e da outbox esvaziarem |
| `LOAD_EVENTS_SINK` | `consume` | consumidor downstream da `wallet-events.fifo`: `consume` (receive + delete), `purge` (só emulador) ou `off` |
| `LOAD_SEED` | `20261008` | semente do PRNG — mesmo mix de operações a cada execução |
| `LOAD_DATABASE_URL`, `LOAD_SQS_ENDPOINT` | `.env` ou `localhost:5432` / `:4566` | leitura do lag da outbox, envio do cenário 4 e verificações |

A execução de referência foi `LOAD_TARGET=local LOAD_EVENTS_SINK=purge LOAD_DRAIN_TIMEOUT_SECONDS=600 bun run test:load`.

## 2. Ambiente da execução de referência

| Item | Valor |
|---|---|
| Máquina | container Linux (kernel 6.18), **2 vCPU** Intel Xeon @ 2.10 GHz, 7,8 GB de RAM — tudo na mesma máquina: gerador de carga, 12 processos da app, PostgreSQL e emulador SQS |
| Réplicas | 3 × `api`, 3 × `consumer`, 3 × `outbox`, 3 × `reprocessor` (mesmo arranjo do `docker-compose.yml`), processos `bun src/main.ts` separados, `LOG_LEVEL=warn`, pool de 10 conexões cada |
| Balanceamento | sem nginx: o cliente alterna entre as 3 APIs (round-robin) |
| Runtime | Bun 1.4.2 · NestJS 12 · MikroORM 7.2.4 |
| PostgreSQL | 16.15 nativo, `max_connections=300`, `shared_buffers=128MB`, **`fsync=off`** (commit mais barato que no Compose — otimista para latência) |
| SQS | `moto` 5.2.3 (`moto_server`, processo Python único) com o mesmo `docker/localstack-init.sh` |
| Fila de eventos | `LOAD_EVENTS_SINK=purge` (ver §3.4) |
| Data | 2026-10-08 |

## 3. Metodologia

### 3.1 Gerador

Malha **fechada**: `N` trabalhadores (a concorrência do cenário), cada um envia uma operação, espera a resposta e
envia a próxima, até acabar o tempo. O throughput é consequência da latência — não há taxa-alvo. Cada operação
tem `Idempotency-Key` = `externalTransactionId` próprios da execução (prefixo `L<timestamp>-s<cenário>`), então
execuções seguidas não colidem. Valores monetários vêm de uma lista fixa de strings (`1.00`, `2.50`, `5.00`,
`10.00`, `20.00`); o teste nunca faz conta com dinheiro.

### 3.2 Fases de cada cenário

1. Abre as wallets por `POST /wallets` (fora da medição).
2. **Aquecimento** de 5 s com o mesmo mix (JIT, pools de conexão, caches do PostgreSQL) — descartado.
3. Espera o sistema ficar quieto: fila de entrada vazia, outbox sem pendências, nenhuma transação pendente.
4. Snapshot do `/metrics` de **todas** as 12 instâncias.
5. **Janela medida** de 30 s. O lag da outbox é amostrado no banco a cada segundo (mesma definição do gauge
   `outbox_lag_seconds`: idade da mais antiga não publicada — o gauge só é coletado a cada 5 s).
6. Fim da carga → mede quanto tempo a fila de entrada e a outbox levam para esvaziar.
7. Segundo snapshot do `/metrics`; contadores e histogramas do relatório são **diferenças entre os snapshots,
   somadas entre instâncias** (percentis dos histogramas por interpolação nos buckets, de 1 ms a 10 s).
8. **Verificação** de todas as wallets do cenário (abaixo).

### 3.3 Verificação (o cenário falha se qualquer item falhar)

- `POST /wallets/:id/reconciliation` → `consistent: true` em **todas** as wallets;
- no PostgreSQL (sobre `NUMERIC`): saldo = Σ créditos − Σ débitos, versões contíguas desde 1 (2 se a wallet abriu com 0.00) até `wallet.version`,
  `balance_before` de cada lançamento = `balance_after` do anterior, aritmética de cada lançamento, nada negativo;
- **uma transação por key enviada**: nº de linhas ≤ keys enviadas e ≥ keys com resposta definitiva (200/201/202/422)
  + mensagens enviadas à fila; nenhuma linha com key desconhecida;
- **um lançamento por transação que move saldo** (`PROCESSED` exceto LOSS, inclusive OPENING) — nenhum débito ou
  crédito duplicado;
- nada `PENDING`/`PENDING_REFERENCE` sobrando e nada novo na DLQ.

### 3.4 Fila de eventos (downstream)

Nenhum serviço do repositório consome a `wallet-events.fifo`; sem consumidor ela só cresce. No `moto` isso
destrói o experimento: deduplicação, `DeleteMessage` e `ReceiveMessage` percorrem a fila inteira, e um
`SendMessageBatch` passou de **16–30 ms (fila vazia) para ~1,6 s com ~4 mil mensagens** — mediria o emulador, não
o publisher. O teste tem um consumidor downstream: `consume` (receive + delete, como um assinante real) é o
default; `purge` (`PurgeQueue` a cada segundo) foi necessário no `moto` porque, na hot wallet (um único grupo
FIFO, 10 mensagens em voo por vez), nem o `consume` acompanhava. O SQS real e o LocalStack limitam o purge a 1
por 60 s — no Compose use o default `consume`.

## 4. Cenários

| # | Cenário | Wallets (saldo inicial) | Concorrência | Mix |
|---|---|---|---|---|
| 1 | **Hot wallet** | 1 (1.000.000,00) | 50 | BET 50% · WIN 50% (saldo alto: mede serialização, não rejeição) |
| 2 | **Wallets espalhadas** | 1.000 (1.000,00) | 100 | BET 50% · WIN 25% · LOSS 15% · REFUND 10% (REFUND de uma BET já confirmada com 201, mesma rodada e valor) |
| 3 | **Tempestade de duplicatas** | 200 (1.000,00) | 100 | BET 60% · WIN 40%; **30% das requisições reenviam** uma das últimas 500 operações (mesma key e payload) — parte chega com o original ainda em voo |
| 4 | **HTTP + fila** | 500 (1.000,00) | 100 | 50 trabalhadores HTTP (mix do cenário 2) + 50 enviando `WagerTransactionRequested` à `wager-transactions.fifo` (BET/WIN/LOSS, grupo = wallet); a fila nunca passa do nº de respostas HTTP |

## 5. Resultados da execução de referência

Latências do cliente (requisição → resposta HTTP) em ms. Taxa de erro = respostas fora de 200/201/202/422.

| Cenário | Req. medidas | Throughput | p50 | p95 | p99 | Máx | Erro |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 hot wallet (c=50) | 2.365 | **77,2 req/s** | 575,6 | 1.435,1 | 2.104,4 | 3.618,3 | 0% |
| 2 wallets espalhadas (c=100) | 7.462 | **245,7 req/s** | 367,4 | 851,6 | 1.283,5 | 1.505,4 | 0% |
| 3 duplicatas (c=100) | 9.198 | **303,2 req/s** | 249,4 | 815,4 | 922,1 | 1.047,2 | 0% |
| 4 HTTP + fila (c=100) | 7.106 HTTP + 693 SQS | **227,1 req/s** HTTP | 191,9 | 489,6 | 613,9 | 788,9 | 0% |

Respostas por código: (1) `201` × 2.365 · (2) `201` × 7.462 · (3) `201` × 6.444, `200 replay` × 2.754 ·
(4) `201` × 7.106. Nenhum 409, 422, 503 ou falha de conexão.

Métricas do servidor (somadas nas 12 instâncias, só a janela medida):

| Cenário | `wallet_lock_wait_seconds` p50 / p95 / p99 | `wallet_lock_conflicts_total` (timeout · deadlock · version) | `processing_duration_seconds` http p50 / p95 | replays (`idempotent_replays_total`) |
|---|---|---|---|---|
| 1 | **246 / 1.210 / 2.269 ms** | 0 · 0 · 0 | 594 / 2.041 ms | 0 |
| 2 | 8 / 39 / 85 ms | 0 · 0 · 0 | 358 / 953 ms | 0 |
| 3 | 7 / 42 / 106 ms | 0 · 0 · 0 | 233 / 896 ms | **2.754** (= reenvios feitos) |
| 4 | 8 / 41 / 89 ms | 0 · 0 · 0 | 172 / 483 ms (sqs: 98 / 465 ms) | 0 · `inbox_duplicates_total` 2 |

Outbox e filas:

| Cenário | Outbox: lag máx. | lag no fim da carga | lag final | pendentes máx. | outbox esvazia em | fila de entrada esvazia em |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 7,4 s | 7,4 s | 0 | 1.002 | 6,1 s | — |
| 2 | **75,3 s** | 25,4 s | 0 | 11.611 | 75,0 s | — |
| 3 | 68,4 s | 24,9 s | 0 | 10.600 | 68,5 s | — |
| 4 | **90,8 s** | 30,3 s | 0 | 13.789 | 93,5 s | 19,6 s |

Cenário 4, canal SQS: 693 mensagens na janela; `SendMessage` p50 2,1 s; **ponta a ponta** (envio → `processed_at`)
p50 8,9 s / p95 16,9 s / p99 17,3 s; 13,6 msg/s processadas (janela + drenagem).

**Reconciliação: 100% consistente nos quatro cenários** — 1/1, 1.000/1.000, 200/200 e 500/500 wallets
`consistent: true`; 0 violações no SQL; transações = keys enviadas (2.737 · 8.735 · 7.355 · 9.041, contando o
aquecimento); lançamentos = transações que movem saldo (2.738 · 8.448 · 7.555 · 8.181); nada pendente; DLQ sem
mensagens novas.

## 6. Análise

**Cenário 1 — a serialização por wallet é o gargalo, como esperado.** Todas as 50 requisições disputam o mesmo
`SELECT … FOR NO KEY UPDATE`; o throughput (77 req/s) corresponde a ~13 ms de lock segurado por operação (INSERT
da transação já feito, UPDATE da wallet, INSERT no ledger, UPDATE da transação, 1–2 INSERTs na outbox e o COMMIT,
numa máquina saturada). A espera pelo lock domina a latência: `wallet_lock_wait` p50 246 ms ≈ metade do p50 do
cliente, e o p95 de 1,2 s é a fila de ~50 operações à frente. **O p99 de 2,27 s já está perto do `lock_timeout` de
3 s**: com concorrência maior numa única wallet, as primeiras respostas seriam 503 `TRANSIENT_UNAVAILABLE`
(`wallet_lock_conflicts_total{type="timeout"}`) — o comportamento desenhado (o provedor reenvia com a mesma key),
não perda de dado. Nenhum deadlock e nenhum conflito de versão: o lock pessimista faz as operações esperarem em
fila em vez de colidirem e repetirem (com lock otimista, 50 escritores na mesma linha virariam tempestade de
retries).

**Cenário 2 × cenário 1 — wallets diferentes andam em paralelo.** Com 1.000 wallets, o throughput sobe 3,2× (246
req/s) com o dobro de concorrência, e a espera de lock cai para p50 8 ms / p95 39 ms — praticamente sem disputa
(com 100 requisições em voo sobre 1.000 wallets, colisões são raras; o que sobra é o tempo do próprio `SELECT … FOR
NO KEY UPDATE` numa máquina sem CPU livre). Aqui o limite **não é o lock**: é CPU. Duas vCPUs para o gerador, 12
processos Bun, o PostgreSQL e o emulador SQS — o `processing_duration` p50 de 358 ms com espera de lock de 8 ms
mostra o tempo indo para escalonamento e I/O, não para contenção. Numa máquina maior, este cenário é o que escala
com réplicas de API; o 1 não (só fica mais rápido se cada operação ficar mais curta).

**Cenário 3 — duplicatas são baratas e exatas.** 2.754 reenvios → 2.754 `idempotentReplay: true` (nenhum virou
segundo débito), transações = keys distintas e lançamentos = transações que movem saldo. Replays não pegam lock
(`wallet_lock_wait` contou 6.444 = só as operações novas), por isso o throughput é o maior dos quatro: 30% das
requisições são um `INSERT … ON CONFLICT DO NOTHING` + leitura. Reenvios com o original ainda em voo esperam no
índice único até o commit do vencedor e então leem a linha — nenhuma resposta 409 apareceu.

**Outbox — o primeiro componente a ficar para trás (cenários 2–4).** Os cenários 2–4 geram ~1,9 evento por
transação (~450–500 eventos/s); os 3 publishers drenaram ~150 eventos/s neste ambiente. O lag cresce linearmente
durante a carga (25–30 s no fim da janela, até 91 s no pico, já na drenagem) e volta a zero sozinho, sem perda —
todos os eventos publicados, outbox zerada antes da verificação. Dois fatores: (a) o publisher envia os blocos de 10
do lote de 50 **em sequência** (5 idas ao SQS por iteração, segurando as linhas com `FOR UPDATE SKIP LOCKED`) e (b)
o `moto` é um processo Python único, disputando as mesmas 2 vCPUs. Lag de outbox é atraso de notificação, não de
saldo: a transação já está commitada e a resposta HTTP já saiu.

**Cenário 4 — a fila ficou limitada pelo emulador.** O lado HTTP não foi segurado pela fila (227 req/s, latências
menores que no cenário 2 porque metade dos trabalhadores ficou esperando o SQS), mas só 693 mensagens entraram em
30 s: o `SendMessage` no `moto` levou p50 2,1 s com o emulador a 100% de CPU, e o consumo ficou em ~14 msg/s
(ponta a ponta p50 8,9 s). O processamento em si é rápido (`processing_duration{source="sqs"}` p50 98 ms) — o
tempo está no emulador (long-poll e varredura de fila FIFO com 500 grupos). As 2 duplicatas de inbox mostram
redelivery real sob carga (ack atrasado → mensagem reentregue → inbox descarta), sem efeito duplicado. A meta de
"metade via SQS" **não foi atingida neste ambiente** por causa do emulador; a rodada no LocalStack (§7) é que vale
para o canal de fila.

## 7. Limitações do experimento

- **Tudo numa máquina de 2 vCPU**: gerador, 12 processos, banco e emulador competem por CPU. Os números medem o
  conjunto, não a capacidade de uma instância. O gerador em malha fechada também desacelera junto com o sistema
  (não mede comportamento sob taxa de chegada fixa).
- **Emulador ≠ SQS real**: `moto` (e LocalStack) não têm o desempenho nem os limites do SQS (300 TPS por ação em
  FIFO sem *high throughput mode*, 3.000 com lotes). O `moto` degrada com o tamanho da fila (§3.4) e é
  single-threaded. A execução de referência usou `moto`, não o LocalStack do Compose.
- **`fsync=off`** no PostgreSQL da execução de referência: commits mais baratos que no Compose (que usa o default
  `fsync=on`) — latências de escrita otimistas.
- **Sem nginx** na execução de referência (round-robin no cliente); no Compose há um salto a mais.
- **Janela de 30 s**: suficiente para ver a tendência do lag da outbox e da espera de lock, curta para efeitos de
  autovacuum, crescimento de índice e cache frio. Sem repetição estatística (uma execução por cenário).
- **Sem falhas injetadas**: falhas e recuperação estão cobertas pela suíte de concorrência (F13), não aqui.
- **Pendente (Wesley, no Mac)**: `LOG_LEVEL=warn docker compose up -d --build && bun run test:load` (default
  `LOAD_TARGET=compose`, `LOAD_EVENTS_SINK=consume`) e anexar a tabela/JSON dessa rodada a este documento. O
  modo `compose` (HTTP pelo nginx, métricas por `docker exec`) não pôde ser executado no ambiente de quem implementou.

## 8. Trabalho futuro (não feito — otimização está fora do escopo da fase)

- **Publisher da outbox**: enviar os 5 blocos do lote em paralelo, lote maior por iteração e mais réplicas — o
  `SKIP LOCKED` já permite N publishers sem coordenação.
- **Hot wallet**: encurtar o tempo com o lock (menos idas ao banco por operação — p.ex. INSERTs da outbox num só
  comando), ou, se o negócio aceitar, sub-wallets/particionamento de saldo. `lock_timeout` maior troca 503 por
  latência.
- **Pool de conexões / PgBouncer**: 12 processos × 10 conexões; medir com pool maior nas APIs e menor nos workers.
- **Logs**: a linha `info` por transação (F14) é volume relevante sob carga; amostragem ou `warn` em produção.
- **Gerador em malha aberta** (taxa fixa) e execução distribuída (gerador fora da máquina do sistema) para medir
  latência sob taxa de chegada controlada.
- Rodar contra SQS real (ou LocalStack com mais CPU) para medir o canal de fila sem o limite do emulador.
