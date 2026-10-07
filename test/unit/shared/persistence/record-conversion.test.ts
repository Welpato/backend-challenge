import { describe, expect, it } from 'bun:test';
import { CorruptRecordError } from '@/shared/persistence/persistence.errors';
import {
  assertPositiveInteger,
  fromSafeInteger,
  optionalMoneyFromColumns,
  toSafeInteger,
} from '@/shared/persistence/record-conversion';

describe('record conversion', () => {
  it('converts bigint strings to safe integers and back', () => {
    expect(toSafeInteger('1', 'v')).toBe(1);
    expect(toSafeInteger('9007199254740991', 'v')).toBe(Number.MAX_SAFE_INTEGER);
    expect(fromSafeInteger(57, 'v')).toBe('57');
  });

  it.each(['9007199254740992', '1.5', 'abc', ''])('rejects bigint column value %p', (value) => {
    expect(() => toSafeInteger(value, 'v')).toThrow(CorruptRecordError);
  });

  it('rejects unsafe integers when writing', () => {
    expect(() => fromSafeInteger(2 ** 53, 'v')).toThrow(CorruptRecordError);
    expect(() => fromSafeInteger(1.5, 'v')).toThrow(CorruptRecordError);
  });

  it('builds the optional snapshot only when both columns are set', () => {
    expect(optionalMoneyFromColumns(null, null, 'b')).toBeUndefined();
    expect(optionalMoneyFromColumns('10.00', 'BRL', 'b')?.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(() => optionalMoneyFromColumns('10.00', null, 'b')).toThrow(CorruptRecordError);
    expect(() => optionalMoneyFromColumns(null, 'BRL', 'b')).toThrow(CorruptRecordError);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects non-positive limit %p', (value) => {
    expect(() => assertPositiveInteger(value, 'limit')).toThrow(RangeError);
  });
});
