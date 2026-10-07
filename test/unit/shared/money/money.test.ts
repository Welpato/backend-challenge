import { describe, expect, it } from 'bun:test';
import { DomainError } from '@/shared/errors/domain-error';
import { FailureCode } from '@/shared/failure-code';
import { Money } from '@/shared/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '@/shared/money/money.errors';
import type { MoneyProps } from '@/shared/money/money-props';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

describe('Money.from', () => {
  describe('accepts valid input', () => {
    for (const amount of ['0.00', '0.01', '25.00', '1000.00', '999999999999999999.99']) {
      it(`accepts "${amount}" and round-trips it`, () => {
        const money = brl(amount);
        expect(money.toString()).toBe(amount);
        expect(money.currency).toBe('BRL');
        expect(money.toJSON()).toEqual({ amount, currency: 'BRL' });
      });
    }
  });

  describe('rejects invalid amounts', () => {
    const invalidAmounts: ReadonlyArray<[string, string]> = [
      ['empty string', ''],
      ['letters', 'abc'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['scientific notation', '1e3'],
      ['three decimal places', '1.234'],
      ['no decimal places', '1'],
      ['one decimal place', '1.5'],
      ['negative value', '-1.00'],
      ['negative zero', '-0.00'],
      ['explicit plus sign', '+1.00'],
      ['leading whitespace', ' 1.00'],
      ['trailing whitespace', '1.00 '],
      ['trailing newline', '1.00\n'],
      ['leading zero', '01.00'],
      ['comma as separator', '1,00'],
      ['missing integer part', '.50'],
      ['19 integer digits', '1000000000000000000.00'],
      ['non-ASCII digits', '١.٠٠'],
    ];
    for (const [label, amount] of invalidAmounts) {
      it(`rejects ${label} (${JSON.stringify(amount)})`, () => {
        expect(() => brl(amount)).toThrow(InvalidMoneyError);
      });
    }

    it('rejects a JS number amount', () => {
      const props = { amount: 25, currency: 'BRL' } as unknown as MoneyProps;
      expect(() => Money.from(props)).toThrow(InvalidMoneyError);
    });

    it('rejects a bigint amount', () => {
      const props = { amount: 2500n, currency: 'BRL' } as unknown as MoneyProps;
      expect(() => Money.from(props)).toThrow(InvalidMoneyError);
    });

    it('rejects null props', () => {
      expect(() => Money.from(null as unknown as MoneyProps)).toThrow(InvalidMoneyError);
    });
  });

  describe('rejects invalid currencies', () => {
    for (const currency of ['brl', 'BRLL', 'BR', '', 'B1L', ' BRL']) {
      it(`rejects ${JSON.stringify(currency)}`, () => {
        expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
      });
    }

    it('rejects a missing currency', () => {
      expect(() => Money.from({ amount: '1.00' } as unknown as MoneyProps)).toThrow(InvalidMoneyError);
    });
  });

  it('does not echo the rejected amount in the error message', () => {
    try {
      brl('123.456');
      throw new Error('expected InvalidMoneyError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMoneyError);
      expect((error as Error).message).not.toContain('123');
    }
  });
});

describe('Money.zero', () => {
  it('creates a zero amount in the given currency', () => {
    const zero = Money.zero('USD');
    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
  });

  it('validates the currency', () => {
    expect(() => Money.zero('usd')).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  it('adds without rounding: 0.10 + 0.20 == 0.30', () => {
    const sum = brl('0.10').add(brl('0.20'));
    expect(sum.toString()).toBe('0.30');
    expect(sum.equals(brl('0.30'))).toBe(true);
  });

  it('adds 0.01 one million times to exactly 10000.00', () => {
    const cent = brl('0.01');
    let total = Money.zero('BRL');
    for (let i = 0; i < 1_000_000; i++) {
      total = total.add(cent);
    }
    expect(total.toString()).toBe('10000.00');
  });

  it('keeps exact values at the 18-digit boundary', () => {
    const max = brl('999999999999999999.99');
    expect(max.subtract(brl('0.01')).toString()).toBe('999999999999999999.98');
    expect(max.subtract(max).isZero()).toBe(true);
  });

  it('rejects results that do not fit NUMERIC(20,2)', () => {
    const max = brl('999999999999999999.99');
    expect(() => max.add(brl('0.01'))).toThrow(InvalidMoneyError);
    expect(() => Money.zero('BRL').subtract(max).subtract(brl('0.01'))).toThrow(InvalidMoneyError);
  });

  it('subtracts', () => {
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
  });

  it('allows subtract to go negative (the balance rule belongs to Wallet)', () => {
    const result = brl('20.00').subtract(brl('80.00'));
    expect(result.isNegative()).toBe(true);
    expect(result.toString()).toBe('-60.00');
    expect(result.toJSON()).toEqual({ amount: '-60.00', currency: 'BRL' });
  });

  it('negates', () => {
    const negated = brl('12.30').negate();
    expect(negated.toString()).toBe('-12.30');
    expect(negated.isNegative()).toBe(true);
    expect(negated.negate().equals(brl('12.30'))).toBe(true);
  });

  it('formats small negative values with leading zero', () => {
    expect(brl('0.05').negate().toString()).toBe('-0.05');
    expect(brl('0.50').negate().toString()).toBe('-0.50');
  });

  it('negating zero stays zero and non-negative', () => {
    const negatedZero = Money.zero('BRL').negate();
    expect(negatedZero.isZero()).toBe(true);
    expect(negatedZero.isNegative()).toBe(false);
    expect(negatedZero.toString()).toBe('0.00');
  });
});

describe('Money predicates and comparison', () => {
  it('classifies zero, positive and negative values', () => {
    const zero = brl('0.00');
    const positive = brl('0.01');
    const negative = positive.negate();
    expect([zero.isZero(), zero.isPositive(), zero.isNegative()]).toEqual([true, false, false]);
    expect([positive.isZero(), positive.isPositive(), positive.isNegative()]).toEqual([false, true, false]);
    expect([negative.isZero(), negative.isPositive(), negative.isNegative()]).toEqual([false, false, true]);
  });

  it('compares with isLessThan', () => {
    expect(brl('9.99').isLessThan(brl('10.00'))).toBe(true);
    expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
    expect(brl('10.01').isLessThan(brl('10.00'))).toBe(false);
    expect(brl('1.00').negate().isLessThan(Money.zero('BRL'))).toBe(true);
  });

  it('compares with equals', () => {
    expect(brl('25.00').equals(brl('25.00'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
  });
});

describe('Money currency conflicts', () => {
  const operations: ReadonlyArray<[string, (a: Money, b: Money) => unknown]> = [
    ['add', (a, b) => a.add(b)],
    ['subtract', (a, b) => a.subtract(b)],
    ['isLessThan', (a, b) => a.isLessThan(b)],
    ['equals', (a, b) => a.equals(b)],
  ];
  for (const [name, operation] of operations) {
    it(`${name} rejects BRL x USD with CurrencyMismatchError`, () => {
      expect(() => operation(brl('1.00'), usd('1.00'))).toThrow(CurrencyMismatchError);
    });
  }

  it('reports the currencies and the CURRENCY_MISMATCH code', () => {
    try {
      brl('1.00').add(usd('1.00'));
      throw new Error('expected CurrencyMismatchError');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const mismatch = error as CurrencyMismatchError;
      expect(mismatch.code).toBe(FailureCode.CURRENCY_MISMATCH);
      expect(mismatch.expected).toBe('BRL');
      expect(mismatch.actual).toBe('USD');
      expect(mismatch.name).toBe('CurrencyMismatchError');
    }
  });
});

describe('Money immutability', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(brl('1.00'))).toBe(true);
    expect(Object.isFrozen(brl('1.00').add(brl('2.00')))).toBe(true);
  });

  it('returns new instances and leaves the operands untouched', () => {
    const a = brl('10.00');
    const b = brl('2.50');
    const results = [a.add(b), a.subtract(b), a.negate()];
    for (const result of results) {
      expect(result).not.toBe(a);
      expect(result).not.toBe(b);
    }
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('2.50');
  });

  it('cannot be mutated through property assignment', () => {
    const money = brl('10.00');
    expect(() => {
      (money as unknown as { currency: string }).currency = 'USD';
    }).toThrow(TypeError);
    expect(money.currency).toBe('BRL');
  });

  it('toJSON returns a fresh object', () => {
    const money = brl('10.00');
    const json = money.toJSON();
    json.amount = '99.99';
    expect(money.toString()).toBe('10.00');
  });

  it('serializes through JSON.stringify as MoneyProps', () => {
    expect(JSON.stringify({ money: brl('25.00') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });

  it('values with different amounts are not deep-equal in tests', () => {
    expect(brl('1.00')).not.toEqual(brl('2.00'));
    expect(brl('1.00')).toEqual(brl('1.00'));
  });
});

describe('Money errors', () => {
  it('InvalidMoneyError is a DomainError with VALIDATION_ERROR code', () => {
    const error = new InvalidMoneyError('bad');
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(FailureCode.VALIDATION_ERROR);
    expect(error.name).toBe('InvalidMoneyError');
  });
});
