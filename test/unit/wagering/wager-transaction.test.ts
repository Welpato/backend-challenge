import { describe, expect, it } from 'bun:test';
import { FailureCode, failureCodeMetadata } from '@/shared/failure-code';
import { computePayloadHash } from '@/wagering/domain/payload-hash';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import { INTERNAL_PROVIDER_ID, WagerTransaction } from '@/wagering/domain/wager-transaction';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '@/wagering/domain/wagering.errors';
import { LedgerDirection } from '@/wallet/domain/ledger-direction';
import { AT, brl, createProps, LATER, stored, usd } from './wagering-fixtures';

const K = WagerTransactionKind;
const S = WagerTransactionStatus;
const SUBMITTABLE = [K.Bet, K.Win, K.Loss, K.Refund, K.Rollback];

function expectInvalid(act: () => unknown, code: string): void {
  try {
    act();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidWagerTransactionError);
    expect((error as InvalidWagerTransactionError).code).toBe(code);
    return;
  }
  throw new Error('expected InvalidWagerTransactionError');
}

describe('WagerTransaction.create', () => {
  it.each(SUBMITTABLE)('creates a %s in PENDING with a fresh state', (kind) => {
    const tx = WagerTransaction.create(createProps(kind));
    expect(tx.kind).toBe(kind);
    expect(tx.status).toBe(S.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.attempts).toBe(0);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.balanceAfter).toBeUndefined();
    expect(tx.nextAttemptAt).toBeUndefined();
    expect(tx.createdAt.toISOString()).toBe(AT.toISOString());
    expect(tx.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it('keeps a given id and correlationId', () => {
    const tx = WagerTransaction.create(createProps(K.Bet, { id: 'tx-given', correlationId: 'corr-1' }));
    expect(tx.id).toBe('tx-given');
    expect(tx.correlationId).toBe('corr-1');
  });

  it('computes the payload hash from the business fields', () => {
    const props = createProps(K.Refund);
    const tx = WagerTransaction.create(props);
    expect(tx.payloadHash).toBe(computePayloadHash(props));
    expect(tx.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.matchesPayload(computePayloadHash(props))).toBe(true);
  });

  it('rejects OPENING with KIND_NOT_ALLOWED', () => {
    expectInvalid(() => WagerTransaction.create(createProps(K.Opening)), FailureCode.KIND_NOT_ALLOWED);
  });

  it('rejects an unknown kind', () => {
    const props = { ...createProps(K.Bet), kind: 'JACKPOT' as WagerTransactionKind };
    expectInvalid(() => WagerTransaction.create(props), FailureCode.VALIDATION_ERROR);
  });

  it.each([K.Refund, K.Rollback])('%s without reference is rejected', (kind) => {
    expectInvalid(
      () => WagerTransaction.create(createProps(kind, { referenceExternalTransactionId: undefined })),
      FailureCode.VALIDATION_ERROR,
    );
  });

  it.each([K.Refund, K.Rollback, K.Win, K.Bet, K.Loss])('%s with an empty reference is rejected', (kind) => {
    expectInvalid(
      () => WagerTransaction.create(createProps(kind, { referenceExternalTransactionId: '' })),
      FailureCode.VALIDATION_ERROR,
    );
  });

  it.each([K.Win, K.Bet, K.Loss])('%s may be created without reference', (kind) => {
    const tx = WagerTransaction.create(createProps(kind));
    expect(tx.referenceExternalTransactionId).toBeUndefined();
    expect(tx.requiresReference()).toBe(false);
  });

  it('WIN may reference the BET of the round', () => {
    const tx = WagerTransaction.create(createProps(K.Win, { referenceExternalTransactionId: 'ext-bet' }));
    expect(tx.referenceExternalTransactionId).toBe('ext-bet');
  });

  it('rejects a transaction that references itself', () => {
    expectInvalid(
      () =>
        WagerTransaction.create(
          createProps(K.Rollback, { externalTransactionId: 'ext-x', referenceExternalTransactionId: 'ext-x' }),
        ),
      FailureCode.VALIDATION_ERROR,
    );
  });

  it.each([K.Bet, K.Win, K.Refund, K.Rollback])('%s with zero money is rejected', (kind) => {
    expectInvalid(
      () => WagerTransaction.create(createProps(kind, { money: brl('0.00') })),
      FailureCode.VALIDATION_ERROR,
    );
  });

  it('LOSS accepts zero money', () => {
    const tx = WagerTransaction.create(createProps(K.Loss, { money: brl('0.00') }));
    expect(tx.money.isZero()).toBe(true);
  });

  it.each(SUBMITTABLE)('%s with negative money is rejected', (kind) => {
    expectInvalid(
      () => WagerTransaction.create(createProps(kind, { money: brl('1.00').negate() })),
      FailureCode.VALIDATION_ERROR,
    );
  });

  it.each([
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'walletId',
    'playerId',
    'roundId',
    'gameId',
  ] as const)('rejects an empty %s', (field) => {
    expectInvalid(() => WagerTransaction.create(createProps(K.Bet, { [field]: '' })), FailureCode.VALIDATION_ERROR);
  });

  it('rejects an empty id and an invalid date', () => {
    expectInvalid(() => WagerTransaction.create(createProps(K.Bet, { id: '' })), FailureCode.VALIDATION_ERROR);
    expectInvalid(
      () => WagerTransaction.create(createProps(K.Bet, { at: new Date('invalid') })),
      FailureCode.VALIDATION_ERROR,
    );
  });

  it('copies createdAt (caller mutation does not leak in or out)', () => {
    const at = new Date(AT.getTime());
    const tx = WagerTransaction.create(createProps(K.Bet, { at }));
    at.setUTCFullYear(2000);
    tx.createdAt.setUTCFullYear(1999);
    expect(tx.createdAt.toISOString()).toBe(AT.toISOString());
  });
});

describe('WagerTransaction.createOpening', () => {
  it('is internal, keyed by wallet and already PROCESSED with the opening balance', () => {
    const tx = WagerTransaction.createOpening({
      id: 'tx-open',
      walletId: 'w-9',
      playerId: 'p-9',
      money: brl('1000.00'),
      at: AT,
    });
    expect(tx.id).toBe('tx-open');
    expect(tx.kind).toBe(K.Opening);
    expect(tx.providerId).toBe(INTERNAL_PROVIDER_ID);
    expect(tx.idempotencyKey).toBe('opening:w-9');
    expect(tx.externalTransactionId).toBe('opening:w-9');
    expect(tx.status).toBe(S.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.balanceAfter?.toString()).toBe('1000.00');
    expect(tx.processedAt?.toISOString()).toBe(AT.toISOString());
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('requires a positive amount', () => {
    expectInvalid(
      () => WagerTransaction.createOpening({ walletId: 'w-9', playerId: 'p-9', money: brl('0.00'), at: AT }),
      FailureCode.VALIDATION_ERROR,
    );
  });

  it('cannot be transitioned', () => {
    const tx = WagerTransaction.createOpening({ walletId: 'w-9', playerId: 'p-9', money: brl('10.00'), at: AT });
    expect(() => tx.reject(FailureCode.INSUFFICIENT_FUNDS, brl('0.00'), AT)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction.rehydrate', () => {
  it('restores any state without revalidating it', () => {
    const tx = stored({
      status: S.PendingReference,
      kind: K.Refund,
      referenceExternalTransactionId: 'ext-missing',
      attempts: 7,
      nextAttemptAt: LATER,
      payloadHash: 'f'.repeat(64),
      correlationId: 'corr-x',
    });
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.attempts).toBe(7);
    expect(tx.nextAttemptAt?.toISOString()).toBe(LATER.toISOString());
    expect(tx.payloadHash).toBe('f'.repeat(64));
    expect(tx.correlationId).toBe('corr-x');
  });

  it('restores a terminal rejection', () => {
    const tx = stored({ status: S.Rejected, failureCode: FailureCode.INSUFFICIENT_FUNDS, balanceAfter: brl('3.00') });
    expect(tx.isTerminal()).toBe(true);
    expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(tx.balanceAfter?.toString()).toBe('3.00');
  });
});

describe('PENDING_REFERENCE scheduling', () => {
  const refund = () => WagerTransaction.create(createProps(K.Refund, { referenceExternalTransactionId: 'ext-bet' }));

  it('markPendingReference keeps attempts and stores the schedule', () => {
    const tx = refund();
    tx.markPendingReference(LATER);
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.attempts).toBe(0);
    expect(tx.nextAttemptAt?.toISOString()).toBe(LATER.toISOString());
  });

  it('scheduleNextReferenceAttempt increments attempts each time', () => {
    const tx = refund();
    tx.markPendingReference(LATER);
    const next = new Date(LATER.getTime() + 4000);
    tx.scheduleNextReferenceAttempt(next);
    tx.scheduleNextReferenceAttempt(next);
    expect(tx.attempts).toBe(2);
    expect(tx.nextAttemptAt?.toISOString()).toBe(next.toISOString());
  });

  it('markPendingReference from PENDING_REFERENCE and schedule from PENDING are state errors', () => {
    const tx = refund();
    expect(() => tx.scheduleNextReferenceAttempt(LATER)).toThrow(InvalidTransactionStateError);
    tx.markPendingReference(LATER);
    expect(() => tx.markPendingReference(LATER)).toThrow(InvalidTransactionStateError);
    expect(tx.attempts).toBe(0);
  });

  it('a transaction without reference cannot wait for one', () => {
    expect(() => WagerTransaction.create(createProps(K.Bet)).markPendingReference(LATER)).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it('rejects an invalid date', () => {
    expect(() => refund().markPendingReference(new Date('x'))).toThrow(InvalidWagerTransactionError);
  });

  it('finalizing clears the schedule but keeps the attempt count', () => {
    const tx = refund();
    tx.markPendingReference(LATER);
    tx.scheduleNextReferenceAttempt(LATER);
    tx.reject(FailureCode.REFERENCE_NOT_FOUND, brl('10.00'), LATER);
    expect(tx.nextAttemptAt).toBeUndefined();
    expect(tx.attempts).toBe(1);
  });
});

describe('reject and fail', () => {
  it('reject stores the code, the observed balance and the finalization time', () => {
    const tx = WagerTransaction.create(createProps(K.Bet));
    tx.reject(FailureCode.INSUFFICIENT_FUNDS, brl('5.00'), LATER);
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(tx.balanceAfter?.toString()).toBe('5.00');
    expect(tx.processedAt?.toISOString()).toBe(LATER.toISOString());
  });

  it('reject accepts the wallet balance in another currency for CURRENCY_MISMATCH', () => {
    const tx = WagerTransaction.create(createProps(K.Bet, { money: usd('5.00') }));
    tx.reject(FailureCode.CURRENCY_MISMATCH, brl('100.00'), LATER);
    expect(tx.balanceAfter?.currency).toBe('BRL');
  });

  it('reject only accepts codes persisted as REJECTED', () => {
    for (const code of Object.values(FailureCode)) {
      const tx = WagerTransaction.create(createProps(K.Bet));
      if (failureCodeMetadata(code).persisted === 'REJECTED') {
        tx.reject(code, brl('1.00'), LATER);
        expect(tx.failureCode).toBe(code);
      } else {
        expect(() => tx.reject(code, brl('1.00'), LATER)).toThrow(InvalidWagerTransactionError);
        expect(tx.status).toBe(S.Pending);
      }
    }
  });

  it('reject refuses a negative snapshot', () => {
    const tx = WagerTransaction.create(createProps(K.Bet));
    expect(() => tx.reject(FailureCode.INSUFFICIENT_FUNDS, brl('1.00').negate(), LATER)).toThrow(
      InvalidWagerTransactionError,
    );
    expect(tx.status).toBe(S.Pending);
  });

  it('fail only accepts codes persisted as FAILED', () => {
    for (const code of Object.values(FailureCode)) {
      const tx = WagerTransaction.create(createProps(K.Refund));
      if (failureCodeMetadata(code).persisted === 'FAILED') {
        tx.fail(code, LATER);
        expect(tx.status).toBe(S.Failed);
        expect(tx.balanceAfter).toBeUndefined();
      } else {
        expect(() => tx.fail(code, LATER)).toThrow(InvalidWagerTransactionError);
        expect(tx.status).toBe(S.Pending);
      }
    }
  });
});

describe('queries', () => {
  it.each([
    [K.Opening, true, false],
    [K.Bet, true, false],
    [K.Win, true, false],
    [K.Loss, false, false],
    [K.Refund, true, true],
    [K.Rollback, true, true],
  ])('%s: affectsBalance=%p requiresReference=%p', (kind, affects, requires) => {
    const tx = stored({ kind, referenceExternalTransactionId: requires ? 'ext-other' : undefined });
    expect(tx.affectsBalance()).toBe(affects);
    expect(tx.requiresReference()).toBe(requires);
  });

  it('matchesPayload compares the stored hash', () => {
    const tx = stored({ payloadHash: 'b'.repeat(64) });
    expect(tx.matchesPayload('b'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('c'.repeat(64))).toBe(false);
  });
});

describe('ledgerDirectionFor', () => {
  const rollback = () =>
    stored({
      id: 'tx-rb',
      externalTransactionId: 'ext-rb',
      kind: K.Rollback,
      referenceExternalTransactionId: 'ext-ref',
    });
  const ref = (kind: WagerTransactionKind) => stored({ id: 'tx-ref', externalTransactionId: 'ext-ref', kind });

  it.each([
    [K.Opening, LedgerDirection.Credit],
    [K.Bet, LedgerDirection.Debit],
    [K.Win, LedgerDirection.Credit],
    [K.Refund, LedgerDirection.Credit],
  ])('%s -> %s', (kind, direction) => {
    expect(stored({ kind }).ledgerDirectionFor()).toBe(direction);
  });

  it('LOSS has no ledger entry', () => {
    expect(() => stored({ kind: K.Loss }).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  it.each([
    [K.Bet, LedgerDirection.Credit],
    [K.Win, LedgerDirection.Debit],
    [K.Refund, LedgerDirection.Debit],
  ])('ROLLBACK of %s -> %s', (kind, direction) => {
    expect(rollback().ledgerDirectionFor(ref(kind))).toBe(direction);
  });

  it.each([K.Loss, K.Rollback, K.Opening])('ROLLBACK of %s has no direction', (kind) => {
    expect(() => rollback().ledgerDirectionFor(ref(kind))).toThrow(InvalidWagerTransactionError);
  });

  it('ROLLBACK requires its own referenced transaction', () => {
    expect(() => rollback().ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    expect(() => rollback().ledgerDirectionFor(stored({ externalTransactionId: 'ext-other' }))).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() =>
      rollback().ledgerDirectionFor(stored({ externalTransactionId: 'ext-ref', providerId: 'provider-b' })),
    ).toThrow(InvalidWagerTransactionError);
  });
});
