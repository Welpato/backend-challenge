/**
 * Congela um valor em profundidade (objetos e arrays aninhados) e devolve o próprio valor.
 *
 * Pensado para dados JSON (payloads de eventos e da outbox): depois de congelado, qualquer
 * tentativa de mutação lança `TypeError` em strict mode. Objetos já congelados são percorridos
 * mesmo assim, porque `Object.freeze` é raso.
 */
export function deepFreeze<T>(value: T): T {
  freeze(value, new Set<object>());
  return value;
}

function freeze(value: unknown, seen: Set<object>): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    freeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  Object.freeze(value);
}
