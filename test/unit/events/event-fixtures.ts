import { expect } from 'bun:test';
import type { EventContext } from '@/shared/events/event-context';
import { Money } from '@/shared/money/money';

export const OCCURRED_AT = new Date('2026-10-07T12:00:00.123Z');

/** Contexto com ids sequenciais (`evt-1`, `evt-2`, …). */
export function eventContext(overrides: Partial<EventContext> = {}): EventContext {
  let next = 0;
  return {
    correlationId: 'corr-1',
    causationId: 'msg-1',
    occurredAt: OCCURRED_AT,
    eventIdFactory: () => {
      next += 1;
      return `evt-${next}`;
    },
    ...overrides,
  };
}

/** Falha se houver alguma instância de `Money` (ou qualquer objeto não simples) no valor. */
export function expectPlainJson(value: unknown, path = '$'): void {
  if (typeof value !== 'object' || value === null) {
    expect(['string', 'number', 'boolean'].includes(typeof value) || value === null).toBe(true);
    return;
  }
  expect(value instanceof Money).toBe(false);
  const proto = Object.getPrototypeOf(value);
  expect(proto === Object.prototype || proto === Array.prototype).toBe(true);
  for (const [key, child] of Object.entries(value)) {
    expectPlainJson(child, `${path}.${key}`);
  }
}

/** Atribuição em objeto congelado lança `TypeError` (módulos ES são strict). */
export function expectFrozenDeep(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    expectFrozenDeep(child);
  }
}
