import { InvalidInboxOperationError } from '@/messaging/inbox/inbox.errors';

const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Entrada de `InboxMessage.receive`. */
export interface ReceiveInboxProps {
  /** Id da mensagem no canal de entrada (o `messageId` do envelope SQS). */
  messageId: string;
  /** Consumidor que deduplica — a chave primária é `(consumerName, messageId)`. */
  consumerName: string;
  /** SHA-256 hex do payload; mesma mensagem com hash diferente é conflito (DLQ). */
  payloadHash: string;
  receivedAt: Date;
}

/** Estado persistido em `inbox_messages`. */
export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date | undefined;
}

/**
 * Registro de mensagem recebida, gravado na mesma transação SQL do processamento. A unicidade de
 * `(consumerName, messageId)` no banco é o que torna o reprocessamento de uma redelivery seguro;
 * esta classe só modela o ciclo `recebida → processada` (uma vez).
 */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    private readonly _receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    for (const field of ['messageId', 'consumerName'] as const) {
      if (typeof props[field] !== 'string' || props[field].length === 0) {
        throw new InvalidInboxOperationError(`Invalid inbox message: ${field} is required`);
      }
    }
    if (typeof props.payloadHash !== 'string' || !PAYLOAD_HASH_PATTERN.test(props.payloadHash)) {
      throw new InvalidInboxOperationError('Invalid inbox message: payloadHash must be a lowercase SHA-256 hex');
    }
    InboxMessage.assertValidDate(props.receivedAt, 'receivedAt');
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      InboxMessage.copy(props.receivedAt),
      undefined,
    );
  }

  /** Reconstrução a partir da persistência — não revalida regras. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      InboxMessage.copy(state.receivedAt),
      state.processedAt === undefined ? undefined : InboxMessage.copy(state.processedAt),
    );
  }

  get receivedAt(): Date {
    return InboxMessage.copy(this._receivedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined ? undefined : InboxMessage.copy(this._processedAt);
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Marca como processada. Uma mensagem só é processada uma vez: a segunda chamada lança. */
  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidInboxOperationError(
        `Inbox message ${this.messageId} was already processed by ${this.consumerName}`,
      );
    }
    InboxMessage.assertValidDate(at, 'processedAt');
    this._processedAt = InboxMessage.copy(at);
  }

  private static assertValidDate(date: Date, field: string): void {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new InvalidInboxOperationError(`Invalid inbox message: ${field} must be a valid date`);
    }
  }

  private static copy(date: Date): Date {
    return new Date(date.getTime());
  }
}
