import { describe, expect, it } from 'bun:test';
import { FailureCode } from '@/shared/failure-code';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import {
  canTransition,
  isTerminalStatus,
  WAGER_TRANSACTION_STATUSES,
  WAGER_TRANSACTION_TRANSITIONS,
  WagerTransactionStatus,
} from '@/wagering/domain/transaction-status';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '@/wagering/domain/wagering.errors';
import { AT, brl, LATER, stored, usd } from './wagering-fixtures';

const S = WagerTransactionStatus;
const TERMINALS = [S.Processed, S.Rejected, S.Failed];

/** Status reachable from `from` per ESPECIFICACAO.md §3.3 — written out independently of the constant. */
const EXPECTED: Record<WagerTransactionStatus, WagerTransactionStatus[]> = {
  [S.Pending]: [S.PendingReference, S.Processed, S.Rejected, S.Failed],
  [S.PendingReference]: [S.PendingReference, S.Processed, S.Rejected, S.Failed],
  [S.Processed]: [],
  [S.Rejected]: [],
  [S.Failed]: [],
};

/** A ROLLBACK of `ext-bet` in the given status (has a reference, so every transition is reachable). */
function rollbackIn(status: WagerTransactionStatus): WagerTransaction {
  const terminalFields =
    status === S.Processed
      ? { referenceTransactionId: 'tx-bet', balanceAfter: brl('50.00'), processedAt: AT }
      : status === S.Rejected
        ? { failureCode: FailureCode.ALREADY_REVERSED, balanceAfter: brl('50.00'), processedAt: AT }
        : status === S.Failed
          ? { failureCode: FailureCode.PROCESSING_FAILED, processedAt: AT }
          : {};
  return stored({
    id: 'tx-rollback',
    externalTransactionId: 'ext-rollback',
    idempotencyKey: 'key-rollback',
    kind: WagerTransactionKind.Rollback,
    referenceExternalTransactionId: 'ext-bet',
    status,
    ...terminalFields,
  });
}

/** Calls the domain method that targets `to`. `PENDING` has no method (nothing goes back to it). */
function transition(tx: WagerTransaction, to: WagerTransactionStatus): void {
  if (to === S.Processed) {
    tx.markProcessed('tx-bet', brl('50.00'), LATER);
  } else if (to === S.Rejected) {
    tx.reject(FailureCode.REFERENCE_AMOUNT_MISMATCH, brl('25.00'), LATER);
  } else if (to === S.Failed) {
    tx.fail(FailureCode.PROCESSING_FAILED, LATER);
  } else if (to === S.PendingReference && tx.status === S.PendingReference) {
    tx.scheduleNextReferenceAttempt(LATER);
  } else if (to === S.PendingReference) {
    tx.markPendingReference(LATER);
  } else {
    throw new Error('no transition targets PENDING');
  }
}

function snapshot(tx: WagerTransaction) {
  return {
    status: tx.status,
    failureCode: tx.failureCode,
    referenceTransactionId: tx.referenceTransactionId,
    processedAt: tx.processedAt?.toISOString(),
    balanceAfter: tx.balanceAfter?.toString(),
    attempts: tx.attempts,
    nextAttemptAt: tx.nextAttemptAt?.toISOString(),
  };
}

describe('transition table', () => {
  it('declares exactly the transitions of the specification', () => {
    for (const from of WAGER_TRANSACTION_STATUSES) {
      expect([...WAGER_TRANSACTION_TRANSITIONS[from]].sort()).toEqual([...EXPECTED[from]].sort());
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(WAGER_TRANSACTION_TRANSITIONS)).toBe(true);
    for (const from of WAGER_TRANSACTION_STATUSES) {
      expect(Object.isFrozen(WAGER_TRANSACTION_TRANSITIONS[from])).toBe(true);
    }
  });

  it('marks exactly PROCESSED, REJECTED and FAILED as terminal', () => {
    expect(WAGER_TRANSACTION_STATUSES.filter(isTerminalStatus).sort()).toEqual([...TERMINALS].sort());
  });

  it('never allows going back to PENDING', () => {
    for (const from of WAGER_TRANSACTION_STATUSES) {
      expect(canTransition(from, S.Pending)).toBe(false);
    }
  });
});

describe('WagerTransaction transitions (from × to)', () => {
  const targets = WAGER_TRANSACTION_STATUSES.filter((status) => status !== S.Pending);

  for (const from of WAGER_TRANSACTION_STATUSES) {
    for (const to of targets) {
      const allowed = EXPECTED[from].includes(to);
      it(`${from} -> ${to} ${allowed ? 'is allowed' : 'throws'}`, () => {
        const tx = rollbackIn(from);
        const before = snapshot(tx);
        if (allowed) {
          transition(tx, to);
          expect(tx.status).toBe(to);
          expect(tx.isTerminal()).toBe(TERMINALS.includes(to));
        } else {
          expect(() => transition(tx, to)).toThrow(InvalidTransactionStateError);
          expect(snapshot(tx)).toEqual(before);
        }
      });
    }
  }

  it('reports from/to and a stable code on an invalid transition', () => {
    const tx = rollbackIn(S.Processed);
    try {
      tx.fail(FailureCode.PROCESSING_FAILED, LATER);
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransactionStateError);
      const stateError = error as InvalidTransactionStateError;
      expect(stateError.code).toBe('INVALID_TRANSACTION_STATE');
      expect(stateError.from).toBe(S.Processed);
      expect(stateError.to).toBe(S.Failed);
    }
  });

  it('a terminal transaction never changes, whatever is attempted', () => {
    for (const terminal of TERMINALS) {
      const tx = rollbackIn(terminal);
      const before = snapshot(tx);
      for (const to of targets) {
        expect(() => transition(tx, to)).toThrow(InvalidTransactionStateError);
      }
      expect(() => tx.markPendingReference(LATER)).toThrow(InvalidTransactionStateError);
      expect(() => tx.scheduleNextReferenceAttempt(LATER)).toThrow(InvalidTransactionStateError);
      expect(snapshot(tx)).toEqual(before);
    }
  });
});

describe('markProcessed', () => {
  it('records reference, snapshot and processedAt and clears the schedule', () => {
    const tx = rollbackIn(S.PendingReference);
    tx.markProcessed('tx-bet', brl('50.00'), LATER);
    expect(tx.status).toBe(S.Processed);
    expect(tx.referenceTransactionId).toBe('tx-bet');
    expect(tx.balanceAfter?.toString()).toBe('50.00');
    expect(tx.processedAt?.toISOString()).toBe(LATER.toISOString());
    expect(tx.nextAttemptAt).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
  });

  it('processes a transaction without reference with no reference id', () => {
    const bet = stored({ status: S.Pending });
    bet.markProcessed(undefined, brl('75.00'), LATER);
    expect(bet.referenceTransactionId).toBeUndefined();
  });

  it.each([
    ['missing the reference id of a reversal', () => rollbackIn(S.Pending).markProcessed(undefined, brl('1.00'), AT)],
    [
      'reference id on a transaction without reference',
      () => stored({ status: S.Pending }).markProcessed('x', brl('1.00'), AT),
    ],
    ['snapshot in another currency', () => rollbackIn(S.Pending).markProcessed('tx-bet', usd('1.00'), AT)],
    ['negative snapshot', () => rollbackIn(S.Pending).markProcessed('tx-bet', brl('1.00').negate(), AT)],
    ['invalid date', () => rollbackIn(S.Pending).markProcessed('tx-bet', brl('1.00'), new Date('nope'))],
  ])('rejects %s without changing state', (_label, act) => {
    expect(act).toThrow(InvalidWagerTransactionError);
  });

  it('leaves state intact when arguments are invalid', () => {
    const tx = rollbackIn(S.Pending);
    const before = snapshot(tx);
    expect(() => tx.markProcessed(undefined, brl('1.00'), AT)).toThrow(InvalidWagerTransactionError);
    expect(snapshot(tx)).toEqual(before);
  });
});
