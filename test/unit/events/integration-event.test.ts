import { describe, expect, it } from 'bun:test';
import type { EventContext } from '@/shared/events/event-context';
import { IntegrationEvent, type IntegrationEventProps } from '@/shared/events/integration-event';
import { InvalidIntegrationEventError } from '@/shared/events/integration-event.errors';
import { Money } from '@/shared/money/money';
import type { MoneyProps } from '@/shared/money/money-props';
import { eventContext, expectFrozenDeep, OCCURRED_AT } from './event-fixtures';

interface SampleData {
  walletId: string;
  money: MoneyProps;
  nested: { list: { value: number }[] };
  optional?: string;
}

class SampleEvent extends IntegrationEvent<SampleData> {
  readonly eventType = 'SampleEvent';
  readonly version = 3;

  private constructor(props: IntegrationEventProps<SampleData>) {
    super(props);
  }

  static from(data: SampleData, ctx: EventContext, aggregateId = 'agg-1'): SampleEvent {
    return IntegrationEvent.seal(new SampleEvent(IntegrationEvent.propsFrom(aggregateId, data, ctx)));
  }

  /** Burla a tipagem para testar a validação de `data` em runtime. */
  static unsafe(data: unknown, ctx: EventContext = eventContext()): SampleEvent {
    return SampleEvent.from(data as SampleData, ctx);
  }
}

const sampleData = (): SampleData => ({
  walletId: 'wallet-1',
  money: { amount: '25.00', currency: 'BRL' },
  nested: { list: [{ value: 1 }, { value: 2 }] },
});

describe('IntegrationEvent', () => {
  it('serializes the envelope exactly as specified', () => {
    const event = SampleEvent.from(sampleData(), eventContext());
    expect(event.toJSON()).toStrictEqual({
      eventId: 'evt-1',
      eventType: 'SampleEvent',
      aggregateId: 'agg-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-10-07T12:00:00.123Z',
      version: 3,
      data: {
        money: { amount: '25.00', currency: 'BRL' },
        nested: { list: [{ value: 1 }, { value: 2 }] },
        walletId: 'wallet-1',
      },
    });
  });

  it('omits causationId when absent instead of serializing null', () => {
    const event = SampleEvent.from(sampleData(), eventContext({ causationId: undefined }));
    expect('causationId' in event.toJSON()).toBe(false);
    expect(event.causationId).toBeUndefined();
  });

  it('round-trips through JSON.stringify unchanged', () => {
    const event = SampleEvent.from(sampleData(), eventContext());
    expect(JSON.parse(JSON.stringify(event))).toStrictEqual(event.toJSON());
  });

  it('takes eventType and version from the subclass', () => {
    const event = SampleEvent.from(sampleData(), eventContext());
    expect(event.eventType).toBe('SampleEvent');
    expect(event.version).toBe(3);
  });

  it('uses the context eventIdFactory once per event', () => {
    const ctx = eventContext();
    expect(SampleEvent.from(sampleData(), ctx).eventId).toBe('evt-1');
    expect(SampleEvent.from(sampleData(), ctx).eventId).toBe('evt-2');
  });

  it('deep-freezes data so mutation attempts throw', () => {
    const event = SampleEvent.from(sampleData(), eventContext());
    expectFrozenDeep(event.data);
    const data = event.data as SampleData;
    expect(() => {
      data.walletId = 'other';
    }).toThrow(TypeError);
    expect(() => {
      data.money.amount = '1000000.00';
    }).toThrow(TypeError);
    expect(() => {
      data.nested.list.push({ value: 3 });
    }).toThrow(TypeError);
    expect(event.data.money.amount).toBe('25.00');
  });

  it('copies data, so later changes to the source object do not leak into the event', () => {
    const source = sampleData();
    const event = SampleEvent.from(source, eventContext());
    source.money.amount = '99.99';
    source.nested.list.push({ value: 9 });
    expect(event.data.money.amount).toBe('25.00');
    expect(event.data.nested.list).toHaveLength(2);
    expect(Object.isFrozen(source)).toBe(false);
  });

  it('freezes the event instance itself', () => {
    const event = SampleEvent.from(sampleData(), eventContext());
    expect(Object.isFrozen(event)).toBe(true);
    expect(() => {
      (event as { eventType: string }).eventType = 'Other';
    }).toThrow(TypeError);
  });

  it('copies occurredAt on input and output', () => {
    const at = new Date(OCCURRED_AT.getTime());
    const event = SampleEvent.from(sampleData(), eventContext({ occurredAt: at }));
    at.setUTCFullYear(2000);
    event.occurredAt.setUTCFullYear(2001);
    expect(event.occurredAt.toISOString()).toBe('2026-10-07T12:00:00.123Z');
  });

  it('converts a Money that leaked into data to MoneyProps', () => {
    const event = SampleEvent.unsafe({ ...sampleData(), money: Money.from({ amount: '1.50', currency: 'USD' }) });
    expect(event.data.money).toStrictEqual({ amount: '1.50', currency: 'USD' });
    expect(event.data.money instanceof Money).toBe(false);
  });

  it('drops undefined optional fields from data', () => {
    const event = SampleEvent.from({ ...sampleData(), optional: undefined } as unknown as SampleData, eventContext());
    expect('optional' in event.data).toBe(false);
  });

  it.each([
    ['a fractional number', { value: 1.5 }],
    ['a bigint', { value: 10n }],
    ['NaN', { value: Number.NaN }],
    ['a Map', { value: new Map() }],
    ['a function', { value: () => 1 }],
  ])('rejects data containing %s', (_label, data) => {
    expect(() => SampleEvent.unsafe(data)).toThrow(InvalidIntegrationEventError);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
  ])('rejects data that is %s', (_label, data) => {
    expect(() => SampleEvent.unsafe(data)).toThrow(InvalidIntegrationEventError);
  });

  it('rejects cyclic data', () => {
    const data: Record<string, unknown> = { a: 1 };
    data.self = data;
    expect(() => SampleEvent.unsafe(data)).toThrow(InvalidIntegrationEventError);
  });

  it.each([
    ['empty eventId', eventContext({ eventIdFactory: () => '' })],
    ['empty correlationId', eventContext({ correlationId: '' })],
    ['empty causationId', eventContext({ causationId: '' })],
    ['invalid occurredAt', eventContext({ occurredAt: new Date('nope') })],
  ])('rejects %s', (_label, ctx) => {
    expect(() => SampleEvent.from(sampleData(), ctx)).toThrow(InvalidIntegrationEventError);
  });

  it('rejects an empty aggregateId', () => {
    expect(() => SampleEvent.from(sampleData(), eventContext(), '')).toThrow(InvalidIntegrationEventError);
  });

  it('reports INVALID_INTEGRATION_EVENT as the error code', () => {
    try {
      SampleEvent.from(sampleData(), eventContext({ correlationId: '' }));
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidIntegrationEventError);
      expect((error as InvalidIntegrationEventError).code).toBe('INVALID_INTEGRATION_EVENT');
    }
  });
});
