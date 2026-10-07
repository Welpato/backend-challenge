import { CurrencyMismatchError, InvalidMoneyError } from '@/shared/money/money.errors';
import type { MoneyProps } from '@/shared/money/money-props';

/** Até 18 dígitos inteiros e exatamente 2 casas decimais; sem sinal, sem zeros à esquerda. */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CENTS_PER_UNIT = 100n;
/** Maior valor representável em `NUMERIC(20,2)`: 999999999999999999.99. */
const MAX_ABS_CENTS = 10n ** 20n - 1n;

/**
 * Valor monetário exato e imutável: `bigint` de centavos + moeda ISO-4217.
 *
 * Nunca passa por ponto flutuante — o parse e a formatação são feitos sobre strings e `bigint`.
 * Entradas que exigiriam arredondamento são rejeitadas, então não existe regra de arredondamento.
 *
 * `from` é o contrato de entrada e de reidratação do banco e só aceita valores ≥ 0.
 * Resultados de operações (`subtract`, `negate`) podem ser negativos; a regra de saldo
 * não-negativo pertence à `Wallet`, não ao `Money`.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (typeof props !== 'object' || props === null) {
      throw new InvalidMoneyError('Invalid money: expected an object with amount and currency');
    }
    const currency = Money.parseCurrency(props.currency);
    const { amount } = props;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('Invalid money amount: expected a decimal string');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        'Invalid money amount: expected a non-negative decimal string with exactly 2 decimal places and at most 18 integer digits',
      );
    }
    const [units = '', fraction = ''] = amount.split('.');
    return new Money(BigInt(units) * CENTS_PER_UNIT + BigInt(fraction), currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  /** Factory interna para resultados de operações; aceita negativos, mas não estoura `NUMERIC(20,2)`. */
  private static fromCents(cents: bigint, currency: string): Money {
    const abs = cents < 0n ? -cents : cents;
    if (abs > MAX_ABS_CENTS) {
      throw new InvalidMoneyError('Money amount out of range: at most 18 integer digits are supported');
    }
    return new Money(cents, currency);
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('Invalid currency: expected an ISO-4217 code with 3 uppercase letters');
    }
    return currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return Money.fromCents(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Valor com 2 casas e sem moeda: `"25.00"`, `"-12.30"`. */
  toString(): string {
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const units = (abs / CENTS_PER_UNIT).toString();
    const fraction = (abs % CENTS_PER_UNIT).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${units}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
