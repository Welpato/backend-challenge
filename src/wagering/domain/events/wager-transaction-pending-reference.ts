import type { EventContext } from '@/shared/events/event-context';
import { IntegrationEvent, type IntegrationEventProps } from '@/shared/events/integration-event';
import { InvalidIntegrationEventError } from '@/shared/events/integration-event.errors';
import {
  type WagerTransactionEventBase,
  wagerTransactionAggregateId,
  wagerTransactionEventBase,
} from '@/wagering/domain/events/wager-transaction-event-data';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventBase {
  /** Id, no provedor, da transação que ainda não existe ou não foi processada. */
  referenceExternalTransactionId: string;
  /** ISO-8601 da próxima tentativa de resolver a referência. */
  nextAttemptAt: string;
  /** Tentativas já feitas (0 na primeira vez que a transação fica pendente). */
  attempts: number;
}

/** Transação aguardando a referência (`PENDING_REFERENCE`, regra 7.8). */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const base = wagerTransactionEventBase(
      tx,
      WagerTransactionStatus.PendingReference,
      'WagerTransactionPendingReference',
    );
    const { referenceExternalTransactionId, nextAttemptAt } = tx;
    if (referenceExternalTransactionId === undefined || nextAttemptAt === undefined) {
      throw new InvalidIntegrationEventError(
        'WagerTransactionPendingReference requires referenceExternalTransactionId and nextAttemptAt',
      );
    }
    const data: WagerTransactionPendingReferenceData = {
      ...base,
      referenceExternalTransactionId,
      nextAttemptAt: nextAttemptAt.toISOString(),
      attempts: tx.attempts,
    };
    return IntegrationEvent.seal(
      new WagerTransactionPendingReference(IntegrationEvent.propsFrom(wagerTransactionAggregateId(tx), data, ctx)),
    );
  }
}
