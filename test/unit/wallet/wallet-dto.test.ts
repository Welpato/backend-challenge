import { describe, expect, it } from 'bun:test';
import { encodeLedgerCursor } from '@/wallet/application/ledger-cursor';
import { createWalletBodySchema, ledgerQuerySchema, walletIdParamSchema } from '@/wallet/http/wallet.dto';

describe('createWalletBodySchema', () => {
  it('accepts the challenge example', () => {
    const body = createWalletBodySchema.parse({
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(body.playerId).toBe('0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1');
    expect(body.initialBalance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
  });

  it('defaults to 0.00 in the given currency when initialBalance is omitted', () => {
    expect(createWalletBodySchema.parse({ playerId: 'p', currency: 'USD' }).initialBalance.toJSON()).toEqual({
      amount: '0.00',
      currency: 'USD',
    });
  });

  it('requires currency without initialBalance and a matching currency with it', () => {
    expect(createWalletBodySchema.safeParse({ playerId: 'p' }).success).toBe(false);
    expect(
      createWalletBodySchema.safeParse({
        playerId: 'p',
        currency: 'USD',
        initialBalance: { amount: '1.00', currency: 'BRL' },
      }).success,
    ).toBe(false);
    expect(
      createWalletBodySchema.safeParse({
        playerId: 'p',
        currency: 'BRL',
        initialBalance: { amount: '1.00', currency: 'BRL' },
      }).success,
    ).toBe(true);
  });

  it('rejects empty, blank, padded and oversized playerId', () => {
    for (const playerId of ['', '  ', ' p', 'p ', 'x'.repeat(256), 1, null]) {
      expect(createWalletBodySchema.safeParse({ playerId, currency: 'BRL' }).success).toBe(false);
    }
    expect(createWalletBodySchema.safeParse({ playerId: 'x'.repeat(255), currency: 'BRL' }).success).toBe(true);
  });
});

describe('ledgerQuerySchema', () => {
  it('defaults to the first page with limit 50', () => {
    expect(ledgerQuerySchema.parse({})).toEqual({ afterVersion: 0, limit: 50 });
  });

  it('decodes the cursor and parses the limit', () => {
    expect(ledgerQuerySchema.parse({ cursor: encodeLedgerCursor(42), limit: '200' })).toEqual({
      afterVersion: 42,
      limit: 200,
    });
  });

  it('rejects limits out of range or not integer, repeated parameters and invalid cursors', () => {
    for (const query of [
      { limit: '0' },
      { limit: '201' },
      { limit: '1.0' },
      { limit: 'abc' },
      { limit: ['1', '2'] },
      { cursor: ['a', 'b'] },
      { cursor: 'zzz' },
    ]) {
      expect(ledgerQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});

describe('walletIdParamSchema', () => {
  it('accepts UUIDs (v7 included) and rejects anything else', () => {
    expect(walletIdParamSchema.safeParse('0192f291-27dd-7d3f-8071-5f8685deef37').success).toBe(true);
    for (const id of ['', 'abc', '0192f291-27dd-7d3f-8071-5f8685deef3', "1' or '1'='1"]) {
      expect(walletIdParamSchema.safeParse(id).success).toBe(false);
    }
  });
});
