import { describe, expect, it } from 'bun:test';
import { InvalidIntegrationEventError } from '@/shared/events/integration-event.errors';
import { FailureCode } from '@/shared/failure-code';
import { WagerTransactionPendingReference } from '@/wagering/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '@/wagering/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '@/wagering/domain/events/wager-transaction-rejected';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import { WagerTransaction } from '@/wagering/domain/wager-transaction';
import { AT, brl, createProps, LATER, stored, usd } from '../wagering/wagering-fixtures';
import { eventContext, expectFrozenDeep, expectPlainJson } from './event-fixtures';

const ids = {
  walletId: 'wallet-1',
  playerId: 'player-1',
  providerId: 'provider-a',
  roundId: 'round-1',
  gameId: 'game-1',
};

function processedBet(): WagerTransaction {
  const tx = WagerTransaction.create({ ...createProps(WagerTransactionKind.Bet), id: 'tx-1' });
  tx.markProcessed(undefined, brl('975.00'), LATER);
  return tx;
}

function pendingRefund(): WagerTransaction {
  const tx = WagerTransaction.create({ ...createProps(WagerTransactionKind.Refund), id: 'tx-2' });
  tx.markPendingReference(LATER);
  return tx;
}

describe('WagerTransactionProcessed', () => {
  it('serializes the exact envelope with money as strings', () => {
    const event = WagerTransactionProcessed.from(processedBet(), eventContext());
    expect(event.toJSON() as unknown).toStrictEqual({
      eventId: 'evt-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-10-07T12:00:00.123Z',
      version: 1,
      data: {
        ...ids,
        transactionId: 'tx-1',
        externalTransactionId: 'ext-bet',
        kind: 'BET',
        status: 'PROCESSED',
        money: { amount: '25.00', currency: 'BRL' },
        balanceAfter: { amount: '975.00', currency: 'BRL' },
      },
    });
  });

  it('includes referenceTransactionId for an operation with a reference', () => {
    const tx = WagerTransaction.create({ ...createProps(WagerTransactionKind.Refund), id: 'tx-3' });
    tx.markProcessed('tx-bet', brl('1000.00'), LATER);
    const { data } = WagerTransactionProcessed.from(tx, eventContext());
    expect(data.referenceTransactionId).toBe('tx-bet');
    expect(data.kind).toBe(WagerTransactionKind.Refund);
  });

  it('is emitted for LOSS with amount 0.00', () => {
    const tx = WagerTransaction.create({ ...createProps(WagerTransactionKind.Loss), money: brl('0.00') });
    tx.markProcessed(undefined, brl('500.00'), LATER);
    const { data } = WagerTransactionProcessed.from(tx, eventContext());
    expect(data.money).toStrictEqual({ amount: '0.00', currency: 'BRL' });
    expect(data.balanceAfter).toStrictEqual({ amount: '500.00', currency: 'BRL' });
  });

  it('is emitted for the internal OPENING transaction', () => {
    const tx = WagerTransaction.createOpening({ walletId: 'wallet-9', playerId: 'p', money: brl('1000.00'), at: AT });
    const event = WagerTransactionProcessed.from(tx, eventContext());
    expect(event.aggregateId).toBe('wallet-9');
    expect(event.data.kind).toBe(WagerTransactionKind.Opening);
    expect(event.data.balanceAfter).toStrictEqual({ amount: '1000.00', currency: 'BRL' });
  });

  it.each([
    WagerTransactionStatus.Pending,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ])('refuses a %s transaction', (status) => {
    const failureCode =
      status === WagerTransactionStatus.Rejected
        ? FailureCode.INSUFFICIENT_FUNDS
        : status === WagerTransactionStatus.Failed
          ? FailureCode.PROCESSING_FAILED
          : undefined;
    expect(() => WagerTransactionProcessed.from(stored({ status, failureCode }), eventContext())).toThrow(
      InvalidIntegrationEventError,
    );
  });

  it('refuses a PROCESSED transaction without the balance snapshot', () => {
    expect(() => WagerTransactionProcessed.from(stored(), eventContext())).toThrow(InvalidIntegrationEventError);
  });
});

describe('WagerTransactionRejected', () => {
  it('serializes failureCode and the snapshot in the wallet currency', () => {
    const tx = WagerTransaction.create({
      ...createProps(WagerTransactionKind.Bet),
      id: 'tx-4',
      money: usd('10.00'),
    });
    tx.reject(FailureCode.CURRENCY_MISMATCH, brl('100.00'), LATER);
    const event = WagerTransactionRejected.from(tx, eventContext());
    expect(event.toJSON() as unknown).toStrictEqual({
      eventId: 'evt-1',
      eventType: 'WagerTransactionRejected',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-10-07T12:00:00.123Z',
      version: 1,
      data: {
        ...ids,
        transactionId: 'tx-4',
        externalTransactionId: 'ext-bet',
        kind: 'BET',
        status: 'REJECTED',
        money: { amount: '10.00', currency: 'USD' },
        failureCode: 'CURRENCY_MISMATCH',
        balanceAfter: { amount: '100.00', currency: 'BRL' },
      },
    });
  });

  it('carries the provider reference for reference failures', () => {
    const tx = WagerTransaction.create(createProps(WagerTransactionKind.Rollback));
    tx.reject(FailureCode.REFERENCE_NOT_FOUND, brl('0.00'), LATER);
    const { data } = WagerTransactionRejected.from(tx, eventContext());
    expect(data.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND);
    expect(data.referenceExternalTransactionId).toBe('ext-bet');
  });

  it('omits balanceAfter when the stored transaction has no snapshot', () => {
    const tx = stored({ status: WagerTransactionStatus.Rejected, failureCode: FailureCode.INSUFFICIENT_FUNDS });
    const { data } = WagerTransactionRejected.from(tx, eventContext());
    expect('balanceAfter' in data).toBe(false);
  });

  it.each([WagerTransactionStatus.Processed, WagerTransactionStatus.Failed, WagerTransactionStatus.Pending])(
    'refuses a %s transaction',
    (status) => {
      const failureCode = status === WagerTransactionStatus.Failed ? FailureCode.PROCESSING_FAILED : undefined;
      expect(() => WagerTransactionRejected.from(stored({ status, failureCode }), eventContext())).toThrow(
        InvalidIntegrationEventError,
      );
    },
  );

  it('refuses a REJECTED transaction without failureCode', () => {
    expect(() =>
      WagerTransactionRejected.from(stored({ status: WagerTransactionStatus.Rejected }), eventContext()),
    ).toThrow(InvalidIntegrationEventError);
  });
});

describe('WagerTransactionPendingReference', () => {
  it('serializes the reference, the next attempt and the attempt count', () => {
    const event = WagerTransactionPendingReference.from(pendingRefund(), eventContext({ causationId: undefined }));
    expect(event.toJSON() as unknown).toStrictEqual({
      eventId: 'evt-1',
      eventType: 'WagerTransactionPendingReference',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      occurredAt: '2026-10-07T12:00:00.123Z',
      version: 1,
      data: {
        ...ids,
        transactionId: 'tx-2',
        externalTransactionId: 'ext-refund',
        kind: 'REFUND',
        status: 'PENDING_REFERENCE',
        money: { amount: '25.00', currency: 'BRL' },
        referenceExternalTransactionId: 'ext-bet',
        nextAttemptAt: '2026-10-07T12:00:05.000Z',
        attempts: 0,
      },
    });
  });

  it('reflects a rescheduled attempt', () => {
    const tx = pendingRefund();
    const later = new Date('2026-10-07T12:00:09.000Z');
    tx.scheduleNextReferenceAttempt(later);
    const { data } = WagerTransactionPendingReference.from(tx, eventContext());
    expect(data.attempts).toBe(1);
    expect(data.nextAttemptAt).toBe(later.toISOString());
  });

  it.each([WagerTransactionStatus.Pending, WagerTransactionStatus.Processed])('refuses a %s transaction', (status) => {
    expect(() => WagerTransactionPendingReference.from(stored({ status }), eventContext())).toThrow(
      InvalidIntegrationEventError,
    );
  });

  it('refuses a pending transaction without a reference', () => {
    const tx = stored({ status: WagerTransactionStatus.PendingReference });
    expect(tx.referenceExternalTransactionId).toBeUndefined();
    expect(() => WagerTransactionPendingReference.from(tx, eventContext())).toThrow(InvalidIntegrationEventError);
  });
});

describe('wager transaction events (common)', () => {
  const rejectedBet = (): WagerTransaction => {
    const tx = WagerTransaction.create(createProps(WagerTransactionKind.Bet));
    tx.reject(FailureCode.INSUFFICIENT_FUNDS, brl('10.00'), LATER);
    return tx;
  };
  const events = [
    ['WagerTransactionProcessed', () => WagerTransactionProcessed.from(processedBet(), eventContext())],
    ['WagerTransactionRejected', () => WagerTransactionRejected.from(rejectedBet(), eventContext())],
    ['WagerTransactionPendingReference', () => WagerTransactionPendingReference.from(pendingRefund(), eventContext())],
  ] as const;

  it.each(events)('%s: eventType/version come from the type', (name, build) => {
    const event = build();
    expect(event.eventType).toBe(name);
    expect(event.version).toBe(1);
    expect(event.toJSON().eventType).toBe(name);
  });

  it.each(events)('%s: payload is plain JSON (no Money instance) and round-trips', (_name, build) => {
    const event = build();
    expectPlainJson(event.toJSON());
    expect(JSON.parse(JSON.stringify(event))).toStrictEqual(event.toJSON());
  });

  it.each(events)('%s: data is deeply immutable', (_name, build) => {
    const event = build();
    expectFrozenDeep(event.data);
    expect(() => {
      (event.data.money as { amount: string }).amount = '0.01';
    }).toThrow(TypeError);
    expect(() => {
      (event.data as { status: string }).status = 'PROCESSED';
    }).toThrow(TypeError);
  });

  it.each(events)('%s: aggregateId is the wallet', (_name, build) => {
    expect(build().aggregateId).toBe('wallet-1');
  });

  it('does not change when the transaction changes afterwards', () => {
    const tx = pendingRefund();
    const event = WagerTransactionPendingReference.from(tx, eventContext());
    tx.markProcessed('tx-bet', brl('1025.00'), LATER);
    expect(event.data.status).toBe(WagerTransactionStatus.PendingReference);
  });
});
