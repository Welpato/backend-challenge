import { CanonicalJsonError, canonicalJson } from '@/shared/canonical-json';
import { deepFreeze } from '@/shared/deep-freeze';
import type { EventContext } from '@/shared/events/event-context';
import { InvalidIntegrationEventError } from '@/shared/events/integration-event.errors';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
  data: T;
}

/** Envelope serializado — exatamente o que vai para `outbox_messages.payload` e para o SQS. */
export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  /** Omitido (não `null`) quando ausente. */
  causationId?: string;
  /** ISO-8601 em UTC (`Date#toISOString`). */
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Evento de integração (DESAFIO.md §11). Cada evento concreto é uma subclasse que fixa `eventType`
 * e `version` **no tipo** e expõe uma factory `static from(...)` — o call site nunca passa a string
 * do tipo.
 *
 * `data` é validado como JSON estável (mesmas regras do JSON canônico: sem `number` fracionário,
 * `bigint`, `Map`, ciclos…), copiado e congelado em profundidade. Dinheiro vai como `MoneyProps`
 * (string decimal), nunca como instância de `Money`; se um `Money` escapar para `data`, a cópia o
 * converte pelo `toJSON()`. Por isso `JSON.parse(JSON.stringify(e))` é igual a `e.toJSON()`.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;
  private readonly _occurredAt: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    for (const field of ['eventId', 'aggregateId', 'correlationId'] as const) {
      if (typeof props[field] !== 'string' || props[field].length === 0) {
        throw new InvalidIntegrationEventError(`Invalid integration event: ${field} is required`);
      }
    }
    if (props.causationId !== undefined && (typeof props.causationId !== 'string' || props.causationId.length === 0)) {
      throw new InvalidIntegrationEventError('Invalid integration event: causationId must be a non-empty string');
    }
    if (!(props.occurredAt instanceof Date) || Number.isNaN(props.occurredAt.getTime())) {
      throw new InvalidIntegrationEventError('Invalid integration event: occurredAt must be a valid date');
    }
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this._occurredAt = new Date(props.occurredAt.getTime());
    this.data = IntegrationEvent.freezeData(props.data);
  }

  /** Cópia do instante do fato (`Date` é mutável). */
  get occurredAt(): Date {
    return new Date(this._occurredAt.getTime());
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this._occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }

  /** Monta as props comuns a partir do contexto de emissão (gera o `eventId`). */
  protected static propsFrom<D>(aggregateId: string, data: D, ctx: EventContext): IntegrationEventProps<D> {
    return {
      eventId: ctx.eventIdFactory(),
      aggregateId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data,
    };
  }

  /**
   * Congela a instância já construída. Chamado pelas factories das subclasses: o construtor base
   * não pode congelar porque os campos `eventType`/`version` da subclasse só são definidos depois dele.
   */
  protected static seal<E extends IntegrationEvent<unknown>>(event: E): E {
    return Object.freeze(event);
  }

  private static freezeData<D>(data: D): Readonly<D> {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new InvalidIntegrationEventError('Invalid integration event: data must be a plain object');
    }
    let json: string;
    try {
      json = canonicalJson(data);
    } catch (error) {
      if (error instanceof CanonicalJsonError) {
        throw new InvalidIntegrationEventError(`Invalid integration event data: ${error.message}`, { cause: error });
      }
      throw error;
    }
    return deepFreeze(JSON.parse(json) as D);
  }
}
