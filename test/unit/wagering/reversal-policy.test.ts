import { describe, expect, it } from 'bun:test';
import { FailureCode } from '@/shared/failure-code';
import { type ReversalDecision, ReversalPolicy } from '@/wagering/domain/reversal-policy';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import { WagerTransaction } from '@/wagering/domain/wager-transaction';
import type { WagerTransactionState } from '@/wagering/domain/wager-transaction.state';
import { InvalidWagerTransactionError } from '@/wagering/domain/wagering.errors';
import { LedgerDirection } from '@/wallet/domain/ledger-direction';
import { AT, brl, createProps, stored, usd } from './wagering-fixtures';

const K = WagerTransactionKind;
const S = WagerTransactionStatus;
const CREDIT: ReversalDecision = { outcome: 'APPLY', direction: LedgerDirection.Credit };
const DEBIT: ReversalDecision = { outcome: 'APPLY', direction: LedgerDirection.Debit };
const NO_LEDGER: ReversalDecision = { outcome: 'APPLY' };
const PENDING: ReversalDecision = { outcome: 'PENDING' };
/** Decision when every rule passes against a processed BET. */
function applyOnBet(kind: WagerTransactionKind): ReversalDecision {
  if (kind === WagerTransactionKind.Bet) return DEBIT;
  if (kind === WagerTransactionKind.Loss) return NO_LEDGER;
  return CREDIT;
}
const reject = (code: FailureCode): ReversalDecision => ({ outcome: 'REJECT', code });

/** A REFUND/ROLLBACK/WIN of `ext-ref`, 25.00 BRL, same provider/player/wallet/round as `ref()`. */
function operation(kind: WagerTransactionKind): WagerTransaction {
  return WagerTransaction.create(
    createProps(kind, {
      externalTransactionId: `ext-${kind.toLowerCase()}-op`,
      referenceExternalTransactionId: 'ext-ref',
    }),
  );
}

function ref(kind: WagerTransactionKind = K.Bet, overrides: Partial<WagerTransactionState> = {}): WagerTransaction {
  const needsReference = kind === K.Refund || kind === K.Rollback;
  return stored({
    id: 'tx-ref',
    externalTransactionId: 'ext-ref',
    kind,
    ...(needsReference ? { referenceExternalTransactionId: 'ext-earlier' } : {}),
    ...overrides,
  });
}

describe('ReversalPolicy.evaluate — kind matrix (processed reference)', () => {
  const matrix: [WagerTransactionKind, WagerTransactionKind, ReversalDecision][] = [
    [K.Refund, K.Bet, CREDIT],
    [K.Refund, K.Win, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Refund, K.Loss, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Refund, K.Refund, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Refund, K.Rollback, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Refund, K.Opening, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Rollback, K.Bet, CREDIT],
    [K.Rollback, K.Win, DEBIT],
    [K.Rollback, K.Loss, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Rollback, K.Refund, DEBIT],
    [K.Rollback, K.Rollback, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Rollback, K.Opening, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Win, K.Bet, CREDIT],
    [K.Win, K.Win, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Win, K.Loss, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Win, K.Refund, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Win, K.Rollback, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Win, K.Opening, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Bet, K.Bet, DEBIT],
    [K.Bet, K.Win, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Bet, K.Loss, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Bet, K.Refund, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Bet, K.Rollback, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Bet, K.Opening, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Loss, K.Bet, NO_LEDGER],
    [K.Loss, K.Win, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Loss, K.Loss, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Loss, K.Refund, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Loss, K.Rollback, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
    [K.Loss, K.Opening, reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED)],
  ];

  it.each(matrix)('%s referencing %s', (opKind, refKind, expected) => {
    const decision = ReversalPolicy.evaluate(operation(opKind), ref(refKind));
    expect(decision).toEqual(expected);
  });

  it('returns frozen decisions', () => {
    expect(Object.isFrozen(ReversalPolicy.evaluate(operation(K.Refund), ref()))).toBe(true);
    expect(Object.isFrozen(ReversalPolicy.evaluate(operation(K.Refund), undefined))).toBe(true);
  });
});

describe.each([K.Refund, K.Rollback, K.Win, K.Bet, K.Loss])('ReversalPolicy.evaluate — %s', (opKind) => {
  const isReversal = opKind === K.Refund || opKind === K.Rollback;
  const applied = applyOnBet(opKind);

  it('missing reference -> PENDING', () => {
    expect(ReversalPolicy.evaluate(operation(opKind), undefined)).toEqual(PENDING);
  });

  it.each([S.Pending, S.PendingReference])('reference in %s -> PENDING', (status) => {
    expect(ReversalPolicy.evaluate(operation(opKind), ref(K.Bet, { status }))).toEqual(PENDING);
  });

  it.each([
    [S.Rejected, FailureCode.INSUFFICIENT_FUNDS],
    [S.Failed, FailureCode.PROCESSING_FAILED],
  ])('reference %s -> REFERENCE_NOT_PROCESSED', (status, failureCode) => {
    expect(ReversalPolicy.evaluate(operation(opKind), ref(K.Bet, { status, failureCode }))).toEqual(
      reject(FailureCode.REFERENCE_NOT_PROCESSED),
    );
  });

  it.each([
    ['providerId', { providerId: 'provider-b' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: 'wallet-2' }],
    ['currency', { money: usd('25.00') }],
    ['roundId', { roundId: 'round-2' }],
  ] as const)('different %s -> REFERENCE_MISMATCH', (_field, overrides) => {
    expect(ReversalPolicy.evaluate(operation(opKind), ref(K.Bet, overrides))).toEqual(
      reject(FailureCode.REFERENCE_MISMATCH),
    );
  });

  it('same scope but a different game is accepted (game is not part of rule 7.2)', () => {
    expect(ReversalPolicy.evaluate(operation(opKind), ref(K.Bet, { gameId: 'game-2' })).outcome).toBe('APPLY');
  });

  it.each(['24.99', '25.01', '50.00'])(
    `reference amount %s -> ${isReversal ? 'REFERENCE_AMOUNT_MISMATCH' : 'APPLY'}`,
    (amount) => {
      const decision = ReversalPolicy.evaluate(operation(opKind), ref(K.Bet, { money: brl(amount) }));
      expect(decision).toEqual(isReversal ? reject(FailureCode.REFERENCE_AMOUNT_MISMATCH) : applied);
    },
  );

  it('referenced BET already reversed -> ALREADY_REVERSED', () => {
    const decision = ReversalPolicy.evaluate(operation(opKind), ref(), { alreadyReversed: true });
    expect(decision).toEqual(reject(FailureCode.ALREADY_REVERSED));
  });

  it('not reversed yet -> APPLY', () => {
    expect(ReversalPolicy.evaluate(operation(opKind), ref(), { alreadyReversed: false })).toEqual(applied);
  });
});

describe('ReversalPolicy.evaluate — LOSS with reference', () => {
  it('accepts a zero LOSS against the BET of the round (amount is not compared)', () => {
    const loss = WagerTransaction.create(
      createProps(K.Loss, { money: brl('0.00'), referenceExternalTransactionId: 'ext-ref' }),
    );
    expect(ReversalPolicy.evaluate(loss, ref())).toEqual(NO_LEDGER);
  });
});

describe('ReversalPolicy.evaluate — precedence', () => {
  it('a pending reference waits even when it would mismatch', () => {
    expect(
      ReversalPolicy.evaluate(operation(K.Refund), ref(K.Win, { status: S.PendingReference, roundId: 'round-2' })),
    ).toEqual(PENDING);
  });

  it('a non processed reference wins over a wrong kind', () => {
    expect(
      ReversalPolicy.evaluate(
        operation(K.Refund),
        ref(K.Win, { status: S.Rejected, failureCode: FailureCode.INSUFFICIENT_FUNDS }),
      ),
    ).toEqual(reject(FailureCode.REFERENCE_NOT_PROCESSED));
  });

  it('a wrong kind wins over a mismatch', () => {
    expect(ReversalPolicy.evaluate(operation(K.Refund), ref(K.Win, { roundId: 'round-2' }))).toEqual(
      reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED),
    );
  });

  it('a mismatch wins over a different amount', () => {
    expect(
      ReversalPolicy.evaluate(operation(K.Rollback), ref(K.Bet, { playerId: 'player-2', money: brl('1.00') })),
    ).toEqual(reject(FailureCode.REFERENCE_MISMATCH));
  });

  it('a different amount wins over already reversed', () => {
    expect(
      ReversalPolicy.evaluate(operation(K.Rollback), ref(K.Bet, { money: brl('1.00') }), { alreadyReversed: true }),
    ).toEqual(reject(FailureCode.REFERENCE_AMOUNT_MISMATCH));
  });
});

describe('ReversalPolicy.evaluate — programming errors', () => {
  it.each([K.Win, K.Bet, K.Loss])('does not evaluate a %s without reference', (kind) => {
    expect(() => ReversalPolicy.evaluate(WagerTransaction.create(createProps(kind)), undefined)).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it('does not evaluate an OPENING', () => {
    const opening = WagerTransaction.createOpening({
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('1.00'),
      at: AT,
    });
    expect(() => ReversalPolicy.evaluate(opening, undefined)).toThrow(InvalidWagerTransactionError);
  });

  it('refuses a transaction that is not the referenced one', () => {
    expect(() =>
      ReversalPolicy.evaluate(operation(K.Refund), ref(K.Bet, { externalTransactionId: 'ext-other' })),
    ).toThrow(InvalidWagerTransactionError);
  });
});

describe('ReversalPolicy.insufficientFundsCodeFor', () => {
  it.each([
    [K.Refund, FailureCode.REVERSAL_INSUFFICIENT_FUNDS],
    [K.Rollback, FailureCode.REVERSAL_INSUFFICIENT_FUNDS],
    [K.Bet, FailureCode.INSUFFICIENT_FUNDS],
    [K.Win, FailureCode.INSUFFICIENT_FUNDS],
    [K.Loss, FailureCode.INSUFFICIENT_FUNDS],
    [K.Opening, FailureCode.INSUFFICIENT_FUNDS],
  ])('%s -> %s', (kind, code) => {
    expect(ReversalPolicy.insufficientFundsCodeFor(kind)).toBe(code);
  });
});
