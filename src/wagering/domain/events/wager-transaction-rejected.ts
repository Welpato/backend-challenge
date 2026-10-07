import type { EventContext } from '@/shared/events/event-context';
import { IntegrationEvent, type IntegrationEventProps } from '@/shared/events/integration-event';
import { InvalidIntegrationEventError } from '@/shared/events/integration-event.errors';
import type { FailureCode } from '@/shared/failure-code';
import type { MoneyProps } from '@/shared/money/money-props';
import {
  type WagerTransactionEventBase,
  wagerTransactionAggregateId,
  wagerTransactionEventBase,
} from '@/wagering/domain/events/wager-transaction-event-data';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';

export interface WagerTransactionRejectedData extends WagerTransactionEventBase {
  failureCode: FailureCode;
  /**
   * Saldo observado no momento da rejeição, na **moeda da wallet** (em `CURRENCY_MISMATCH` difere de
   * `money.currency`). Omitido se a transação não tiver snapshot.
   */
  balanceAfter?: MoneyProps;
  /** Referência informada pelo provedor, quando houver (ajuda a diagnosticar `REFERENCE_*`). */
  referenceExternalTransactionId?: string;
}

/** Transação rejeitada por regra de negócio (`REJECTED` + `failureCode`). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const base = wagerTransactionEventBase(tx, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    const { failureCode, balanceAfter, referenceExternalTransactionId } = tx;
    if (failureCode === undefined) {
      throw new InvalidIntegrationEventError('WagerTransactionRejected requires a failureCode');
    }
    const data: WagerTransactionRejectedData = {
      ...base,
      failureCode,
      ...(balanceAfter === undefined ? {} : { balanceAfter: balanceAfter.toJSON() }),
      ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
    };
    return IntegrationEvent.seal(
      new WagerTransactionRejected(IntegrationEvent.propsFrom(wagerTransactionAggregateId(tx), data, ctx)),
    );
  }
}
