import { describe, expect, it } from 'bun:test';
import { canonicalJson } from '@/shared/canonical-json';
import { sha256Hex } from '@/shared/hashing';
import { computePayloadHash, type PayloadHashFields } from '@/wagering/domain/payload-hash';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { WagerTransaction } from '@/wagering/domain/wager-transaction';
import { brl, createProps } from './wagering-fixtures';

const BASE: PayloadHashFields = {
  providerId: 'provider-a',
  externalTransactionId: 'ext-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'ROLLBACK',
  money: { amount: '25.00', currency: 'BRL' },
  referenceExternalTransactionId: 'ext-0',
};

describe('computePayloadHash', () => {
  it('is the SHA-256 of the canonical JSON of the §6 fields', () => {
    const expected = sha256Hex(
      '{"externalTransactionId":"ext-1","gameId":"game-1","kind":"ROLLBACK","money":{"amount":"25.00","currency":"BRL"},' +
        '"playerId":"player-1","providerId":"provider-a","referenceExternalTransactionId":"ext-0","roundId":"round-1","walletId":"wallet-1"}',
    );
    expect(computePayloadHash(BASE)).toBe(expected);
    expect(computePayloadHash(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores key order', () => {
    const reversed = Object.fromEntries(Object.entries(BASE).reverse()) as unknown as PayloadHashFields;
    const moneyReversed = { ...BASE, money: { currency: 'BRL', amount: '25.00' } };
    expect(computePayloadHash(reversed)).toBe(computePayloadHash(BASE));
    expect(computePayloadHash(moneyReversed)).toBe(computePayloadHash(BASE));
  });

  it('treats a Money and its MoneyProps the same', () => {
    expect(computePayloadHash({ ...BASE, money: brl('25.00') })).toBe(computePayloadHash(BASE));
  });

  it.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'ext-2' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: 'wallet-2' }],
    ['roundId', { roundId: 'round-2' }],
    ['gameId', { gameId: 'game-2' }],
    ['kind', { kind: 'REFUND' }],
    ['money.amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['money.currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['referenceExternalTransactionId', { referenceExternalTransactionId: 'ext-9' }],
    ['referenceExternalTransactionId removed', { referenceExternalTransactionId: undefined }],
  ] as const)('changes when %s changes', (_field, change) => {
    expect(computePayloadHash({ ...BASE, ...change })).not.toBe(computePayloadHash(BASE));
  });

  it('omits an absent reference instead of hashing null/undefined', () => {
    const { referenceExternalTransactionId: _omit, ...withoutReference } = BASE;
    expect(computePayloadHash({ ...BASE, referenceExternalTransactionId: undefined })).toBe(
      computePayloadHash(withoutReference),
    );
    expect(canonicalJson({ a: undefined })).toBe('{}');
  });

  it('does not include idempotencyKey, messageId, occurredAt or any other extra field', () => {
    const envelope = {
      ...BASE,
      idempotencyKey: 'key-1',
      messageId: 'msg-1',
      occurredAt: '2026-10-07T12:00:00.000Z',
      correlationId: 'corr-1',
    };
    expect(computePayloadHash(envelope)).toBe(computePayloadHash(BASE));
  });
});

describe('matchesPayload with the payload hash', () => {
  it('same key and same business payload (sent via HTTP and SQS) is a replay', () => {
    const http = WagerTransaction.create(
      createProps(WagerTransactionKind.Bet, { idempotencyKey: 'k', correlationId: 'a' }),
    );
    const sqs = WagerTransaction.create(
      createProps(WagerTransactionKind.Bet, { idempotencyKey: 'k', correlationId: 'b' }),
    );
    expect(http.matchesPayload(sqs.payloadHash)).toBe(true);
  });

  it('a different idempotency key alone does not change the payload', () => {
    const a = WagerTransaction.create(createProps(WagerTransactionKind.Bet, { idempotencyKey: 'k1' }));
    const b = WagerTransaction.create(createProps(WagerTransactionKind.Bet, { idempotencyKey: 'k2' }));
    expect(a.matchesPayload(b.payloadHash)).toBe(true);
  });

  it('same key with a divergent payload is detected as a conflict', () => {
    const stored = WagerTransaction.create(createProps(WagerTransactionKind.Bet, { idempotencyKey: 'k' }));
    const divergent = WagerTransaction.create(
      createProps(WagerTransactionKind.Bet, { idempotencyKey: 'k', money: brl('25.01') }),
    );
    expect(stored.matchesPayload(divergent.payloadHash)).toBe(false);
  });
});
