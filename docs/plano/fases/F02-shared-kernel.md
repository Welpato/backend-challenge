# F02 — Shared kernel: Money, JSON canônico, hash, FailureCode ★

## Objetivo
Construir as peças puras que todo o resto usa, com cobertura de testes alta. `Money` é o item mais sensível do desafio (eliminatória: `number` para dinheiro).

## Ler
- `ESPECIFICACAO.md` §3.1, §3.8, §6 (algoritmo do hash); `DESAFIO.md` §6.1.

## Entregáveis
- `src/shared/money/money-props.ts` — `interface MoneyProps { amount: string; currency: string }`.
- `src/shared/money/money.ts` — classe `Money`:
  - armazenamento interno `bigint` (centavos) + `currency`; construtor `private`;
  - `from(props)` é estrito e aceita **apenas valores não negativos** (contrato de entrada e reidratação do banco, onde valores são sempre ≥ 0); resultados de operação usam a factory privada `fromCents(bigint, currency)`, que aceita negativos;
  - `zero`, `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`, `toJSON`, `toString` (`"-12.30"` quando negativo), `assertSameCurrency` privado;
  - regex de entrada `^(0|[1-9]\d{0,17})\.\d{2}$`; moeda `^[A-Z]{3}$`;
  - **nenhum** `number` em lugar nenhum do fluxo (nem `Number(...)`, `parseFloat`, `toFixed`).
- `src/shared/money/money.errors.ts` — `InvalidMoneyError`, `CurrencyMismatchError` (estendem `DomainError`).
- `src/shared/errors/domain-error.ts` — base com `code: FailureCode | string`.
- `src/shared/failure-code.ts` — enum/const com todos os códigos de §3.8 + metadados `{ class, retryable, persisted }`.
- `src/shared/canonical-json.ts` — serialização determinística (chaves ordenadas recursivamente, sem espaços, omite `undefined`, rejeita `number` não-inteiro, `NaN`, funções).
- `src/shared/hashing.ts` — `sha256Hex(string)` via `Bun.CryptoHasher` ou `node:crypto`.
- `src/shared/ids.ts` (uuid v7), `src/shared/clock.ts` (`Clock` interface + `SystemClock` + `FixedClock` para testes).

## Testes (`test/unit/shared/**`)
- Money válido: `"0.00"`, `"25.00"`, `"999999999999999999.99"`.
- Money inválido (cada um um teste): `""`, `"abc"`, `"NaN"`, `"Infinity"`, `"1e3"`, `"1.234"`, `"1"`, `"1.5"`, `"-1.00"`, `"+1.00"`, `" 1.00"`, `"01.00"`, 19 dígitos inteiros, `25` (number), moeda `"brl"`, `"BRLL"`.
- Sem arredondamento: `"0.10" + "0.20" == "0.30"`; somar 1.000.000 × `"0.01"` dá `"10000.00"`.
- Imutabilidade: operações retornam nova instância; original intacto; `Object.isFrozen`.
- `negate`, `isNegative`, `toString` de negativos; `subtract` que fica negativo é permitido em `Money` (a regra de saldo é da `Wallet`).
- Conflito de moeda em `add`, `subtract`, `isLessThan`, `equals` (BRL × USD).
- JSON canônico: ordem de chaves irrelevante; aninhado; `undefined` omitido.
- Hash: estável, 64 hex.

## Critérios de aceite
```bash
bun test test/unit/shared
bun run typecheck && bun run lint
grep -rnE "parseFloat|Number\(|toFixed|: number" src/shared/money && echo "FALHOU: number em Money" || echo ok
```

## Fora de escopo
Tipos do MikroORM (F07), Wallet (F03).
