/** Token de injeção do `Clock` (provido como `SystemClock` pelo `DatabaseModule`; testes usam `FixedClock`). */
export const CLOCK = Symbol('CLOCK');

/**
 * Fonte de tempo injetável. O domínio recebe instantes como parâmetro; quem chama obtém de um `Clock`,
 * o que torna backoff, TTL e timestamps determinísticos nos testes (`FixedClock`).
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Relógio controlado manualmente, para testes. Sempre devolve uma cópia do instante atual. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(at: Date | string = '2026-01-01T00:00:00.000Z') {
    this.current = FixedClock.toValidDate(at);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(at: Date | string): void {
    this.current = FixedClock.toValidDate(at);
  }

  advance(milliseconds: number): void {
    this.current = FixedClock.toValidDate(new Date(this.current.getTime() + milliseconds));
  }

  private static toValidDate(at: Date | string): Date {
    const date = new Date(typeof at === 'string' ? at : at.getTime());
    if (Number.isNaN(date.getTime())) {
      throw new RangeError('FixedClock requires a valid date');
    }
    return date;
  }
}
