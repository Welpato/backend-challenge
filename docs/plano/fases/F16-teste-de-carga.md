# F16 — Teste de carga (opcional, diferencial)

## Objetivo
Experimento honesto e reproduzível, exposto como `bun run test:load`, com relatório em português. O enunciado valoriza a qualidade da análise mais do que o número de RPS.

## Ler
- `DESAFIO.md` §14 (Diferenciais opcionais).

## Entregáveis
- `test/load/run.ts` — script Bun (ou k6 em container, escolher e registrar) com cenários:
  1. **hot wallet**: 1 wallet, concorrência 50, só BET/WIN;
  2. **wallets espalhadas**: 1.000 wallets, concorrência 100, mix BET/WIN/LOSS/REFUND;
  3. **tempestade de duplicatas**: 30% das requisições repetidas;
  4. **mix HTTP + fila**: metade via SQS.
- Coleta: throughput, p50/p95/p99, taxa de erro por código, `wallet_lock_conflicts_total`, `wallet_lock_wait_seconds`, `outbox_lag_seconds` (máx. e final), duração até a fila esvaziar.
- Ao final de cada cenário: reconciliação de todas as wallets (tem que dar 100% consistente).
- Saída em JSON + tabela no terminal.
- `LOAD_TEST.md` (pt-BR): ambiente (máquina, CPU, RAM, réplicas do compose, versões), metodologia (warm-up, duração, concorrência), resultados por cenário, análise (gargalo esperado: serialização por wallet no cenário 1; comparação com o cenário 2), limitações do experimento (LocalStack ≠ SQS real, tudo numa máquina).

## Critérios de aceite
```bash
docker compose up -d --build
bun run test:load
```
- Relatório gerado, reconciliação 100% consistente em todos os cenários, `LOAD_TEST.md` preenchido com números reais da execução.

## Fora de escopo
Otimização de performance (registrar ideias como "trabalho futuro").
