import { describe, expect, it } from 'bun:test';
import type { Platform } from '@mikro-orm/core';
import { InvalidMoneyColumnError, MoneyAmountType } from '@/shared/persistence/money.type';

const type = new MoneyAmountType();
const platform = {} as Platform;

describe('MoneyAmountType', () => {
  it.each(['0.00', '25.00', '0.10', '999999999999999999.99', '-5.00'])('passes %p through unchanged', (value) => {
    expect(type.convertToJSValue(value)).toBe(value);
    expect(type.convertToDatabaseValue(value)).toBe(value);
  });

  it('never produces or accepts a number', () => {
    expect(() => type.convertToJSValue(25 as unknown as string)).toThrow(InvalidMoneyColumnError);
    expect(() => type.convertToDatabaseValue(25 as unknown as string)).toThrow(InvalidMoneyColumnError);
  });

  it.each(['25', '25.5', '25.000', '1e3', '', ' 1.00', '1000000000000000000.00', 'NaN', '01.00'])(
    'rejects %p',
    (value) => {
      expect(() => type.convertToJSValue(value)).toThrow(InvalidMoneyColumnError);
      expect(() => type.convertToDatabaseValue(value)).toThrow(InvalidMoneyColumnError);
    },
  );

  it('lets NULL through for nullable columns', () => {
    expect(type.convertToJSValue(null as unknown as string)).toBeNull();
    expect(type.convertToDatabaseValue(null as unknown as string)).toBeNull();
  });

  it('declares numeric(20,2) compared as string', () => {
    expect(type.getColumnType({} as never, platform)).toBe('numeric(20,2)');
    expect(type.compareAsType()).toBe('string');
    expect(type.runtimeType).toBe('string');
  });
});
