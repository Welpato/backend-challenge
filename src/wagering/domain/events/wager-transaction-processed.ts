import type { EventContext } from '@/shared/events/event-context';
import { IntegrationEvent, type IntegrationEventProps } from '@/shared/events/integration-event';
import { InvalidIntegrationEventError } from '@/shared/events/integration-event.errors';
import type { MoneyProps } from '@/shared/money/money-props';
import {
  type WagerTransactionEventBase,
  wagerTransactionAggregateId,
  wagerTransactionEventBase,
} from '@/wagering/domain/events/wager-transaction-event-data';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';

export interface WagerTransactionProcessedData extends WagerTransactionEventBase {
  /** Saldo da wallet depois da aplicação (o mesmo snapshot devolvido nos replays). */
  balanceAfter: MoneyProps;
  /** Id interno da transação referenciada; omitido quando a operação não tem referência. */
  referenceTransactionId?: string;
}

/** Qualquer transação aplicada (`PROCESSED`), inclusive LOSS (sem movimento de saldo) e OPENING. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const base = wagerTransactionEventBase(tx, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    const { balanceAfter, referenceTransactionId } = tx;
    if (balanceAfter === undefined) {
      throw new InvalidIntegrationEventError('WagerTransactionProcessed requires the balanceAfter snapshot');
    }
    const data: WagerTransactionProcessedData = {
      ...base,
      balanceAfter: balanceAfter.toJSON(),
      ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
    };
    return IntegrationEvent.seal(
      new WagerTransactionProcessed(IntegrationEvent.propsFrom(wagerTransactionAggregateId(tx), data, ctx)),
    );
  }
}
