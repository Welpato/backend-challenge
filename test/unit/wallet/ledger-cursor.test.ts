import { describe, expect, it } from 'bun:test';
import { decodeLedgerCursor, encodeLedgerCursor, InvalidLedgerCursorError } from '@/wallet/application/ledger-cursor';

describe('ledger cursor', () => {
  it('round-trips the wallet version as opaque base64url of {"v":n}', () => {
    for (const version of [1, 50, 123456, Number.MAX_SAFE_INTEGER]) {
      const cursor = encodeLedgerCursor(version);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({ v: version });
      expect(decodeLedgerCursor(cursor)).toBe(version);
    }
  });

  it('refuses to encode invalid versions', () => {
    for (const version of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => encodeLedgerCursor(version)).toThrow(RangeError);
    }
  });

  const encode = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

  const invalid: readonly [string, string][] = [
    ['empty', ''],
    ['non base64url characters', 'abc$'],
    ['padding', `${encodeLedgerCursor(7)}=`],
    ['standard base64 alphabet', '+/+/'],
    ['not JSON', encode('hello')],
    ['JSON array', encode('[1]')],
    ['JSON null', encode('null')],
    ['missing v', encode('{}')],
    ['extra key', encode('{"v":1,"x":2}')],
    ['v as string', encode('{"v":"1"}')],
    ['v zero', encode('{"v":0}')],
    ['v negative', encode('{"v":-1}')],
    ['v fractional', encode('{"v":1.5}')],
    ['v unsafe integer', encode('{"v":9007199254740993}')],
    ['non-canonical JSON (spaces)', encode('{ "v": 3 }')],
    ['too long', 'a'.repeat(65)],
  ];

  for (const [name, cursor] of invalid) {
    it(`rejects ${name}`, () => {
      expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidLedgerCursorError);
    });
  }

  it('is a contract error (VALIDATION_ERROR)', () => {
    expect(new InvalidLedgerCursorError().code).toBe('VALIDATION_ERROR');
  });
});
