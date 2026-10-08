import { type BackoffOptions, backoffDelayMs } from '@/messaging/outbox/backoff';

/**
 * Parâmetros das referências pendentes (ESPECIFICACAO.md §2 "Fora de ordem", §8): backoff exponencial
 * `base·2ⁿ` com teto e jitter, até `maxAttempts` tentativas ou `ttlMs` desde a criação; esgotado →
 * `REJECTED REFERENCE_NOT_FOUND`. Defaults: 2s, 5 min, 12 tentativas, 30 min (configuráveis por env).
 */
export interface PendingReferenceSettings {
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly maxAttempts: number;
  readonly ttlMs: number;
  /** Só testes: fixa o jitter (`random` em `[0, 1)`). */
  readonly random?: () => number;
}

export const PENDING_REFERENCE_SETTINGS = Symbol('PENDING_REFERENCE_SETTINGS');

export class PendingReferencePolicy {
  constructor(private readonly settings: PendingReferenceSettings) {}

  /**
   * Próxima tentativa: `now + base·2^exponent` (com teto e jitter só para baixo — `backoff.ts`). O expoente é
   * 0 quando a transação acabou de ficar pendente e `attempts` já incrementado nos reagendamentos (2s, 4s, 8s…).
   */
  nextAttemptAt(now: Date, exponent: number): Date {
    const options: BackoffOptions = {
      baseMs: this.settings.backoffBaseMs,
      maxMs: this.settings.backoffMaxMs,
      ...(this.settings.random === undefined ? {} : { random: this.settings.random }),
    };
    return new Date(now.getTime() + backoffDelayMs(exponent, options));
  }

  /**
   * Esgotou? `attempts` = reagendamentos já feitos pelo reprocessador (`WagerTransaction.attempts`). Com os
   * defaults (2s·2ⁿ, teto 5 min) a 12ª reavaliação cai por volta de 33 min: na prática o TTL de 30 min decide
   * primeiro e o limite de tentativas é a rede de proteção quando o backoff é configurado mais curto.
   */
  isExhausted(createdAt: Date, attempts: number, now: Date): boolean {
    return attempts >= this.settings.maxAttempts || createdAt.getTime() + this.settings.ttlMs <= now.getTime();
  }
}
