import { describe, expect, it } from 'bun:test';
import { CanonicalJsonError, canonicalJson } from '@/shared/canonical-json';
import { Money } from '@/shared/money/money';

describe('canonicalJson', () => {
  it('ignores key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested keys recursively and has no whitespace', () => {
    const value = { z: { y: 'y', x: ['b', { d: true, c: null }] }, a: 'a' };
    expect(canonicalJson(value)).toBe('{"a":"a","z":{"x":["b",{"c":null,"d":true}],"y":"y"}}');
  });

  it('omits undefined properties', () => {
    expect(canonicalJson({ a: 'x', b: undefined, c: { d: undefined } })).toBe('{"a":"x","c":{}}');
    expect(canonicalJson({ a: 'x', b: undefined })).toBe(canonicalJson({ a: 'x' }));
  });

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('escapes strings like JSON', () => {
    expect(canonicalJson({ 'k"ey': 'line\nbreak "quoted" ç' })).toBe('{"k\\"ey":"line\\nbreak \\"quoted\\" ç"}');
  });

  it('serializes Money through toJSON', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(canonicalJson({ money })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });

  it('serializes primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-42)).toBe('-42');
    expect(canonicalJson('s')).toBe('"s"');
  });

  it('accepts null-prototype objects', () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, { b: 1, a: 2 });
    expect(canonicalJson(value)).toBe('{"a":2,"b":1}');
  });

  describe('rejects unsupported values', () => {
    const invalid: ReadonlyArray<[string, unknown]> = [
      ['non-integer number', { amount: 25.5 }],
      ['NaN', { value: Number.NaN }],
      ['Infinity', { value: Number.POSITIVE_INFINITY }],
      ['unsafe integer', { value: 2 ** 53 }],
      ['bigint', { value: 10n }],
      ['function', { fn: () => 1 }],
      ['symbol', { value: Symbol('x') }],
      ['undefined at the top level', undefined],
      ['undefined inside an array', [1, undefined]],
      ['class instance without toJSON', { value: new Map() }],
    ];
    for (const [label, value] of invalid) {
      it(label, () => {
        expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
      });
    }

    it('circular references', () => {
      const value: Record<string, unknown> = { a: 1 };
      value.self = value;
      expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
    });
  });

  it('allows the same object to appear twice when it is not circular', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});
