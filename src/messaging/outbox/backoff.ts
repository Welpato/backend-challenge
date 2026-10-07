/**
 * Backoff exponencial com teto e jitter — função pura, reutilizada pela outbox (F11), pelo
 * reprocessador de referências pendentes (F10) e pelo consumidor SQS (F12).
 *
 * `delay = min(baseMs × 2^exponent, maxMs)`, depois o jitter **reduz** o atraso em até
 * `jitterRatio` (fração sorteada por `random()`): o resultado fica em
 * `[(1 − jitterRatio) × teto, teto]`. Jitter só para baixo garante que o teto nunca é ultrapassado
 * e ainda espalha as tentativas de várias instâncias que falharam ao mesmo tempo.
 *
 * Durações em milissegundos são contadores (não dinheiro), por isso `number`. O resultado é sempre
 * um inteiro ≥ 0.
 */
export interface BackoffOptions {
  /** Atraso para `exponent = 0`. */
  baseMs: number;
  /** Teto do atraso (antes e depois do jitter). */
  maxMs: number;
  /** Fração máxima removida pelo jitter, em `[0, 1]`. `0` = determinístico. Padrão `0.2`. */
  jitterRatio?: number;
  /** Fonte de aleatoriedade em `[0, 1)`. Padrão `Math.random`; nos testes, um PRNG com seed. */
  random?: () => number;
}

export const DEFAULT_JITTER_RATIO = 0.2;

/** Outbox: `min(2^attempts × 1s, 5 min)` (ESPECIFICACAO.md §8), com `attempts` já incrementado. */
export const OUTBOX_BACKOFF: Readonly<Pick<BackoffOptions, 'baseMs' | 'maxMs'>> = Object.freeze({
  baseMs: 1_000,
  maxMs: 5 * 60 * 1_000,
});

export function backoffDelayMs(exponent: number, options: BackoffOptions): number {
  const { baseMs, maxMs, jitterRatio = DEFAULT_JITTER_RATIO, random = Math.random } = options;
  if (!Number.isSafeInteger(exponent) || exponent < 0) {
    throw new RangeError('backoff exponent must be a non-negative integer');
  }
  if (!Number.isFinite(baseMs) || baseMs < 0 || !Number.isFinite(maxMs) || maxMs < 0) {
    throw new RangeError('backoff baseMs and maxMs must be finite and non-negative');
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RangeError('backoff jitterRatio must be between 0 and 1');
  }
  // 2 ** exponent vira Infinity para expoentes grandes; o Math.min devolve o teto.
  const capped = Math.min(baseMs * 2 ** exponent, maxMs);
  if (jitterRatio === 0) {
    return Math.floor(capped);
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError('backoff random() must return a number in [0, 1)');
  }
  return Math.floor(capped * (1 - jitterRatio * sample));
}

/** `now + backoffDelayMs(...)`, como nova `Date`. */
export function nextAttemptAt(now: Date, exponent: number, options: BackoffOptions): Date {
  return new Date(now.getTime() + backoffDelayMs(exponent, options));
}
