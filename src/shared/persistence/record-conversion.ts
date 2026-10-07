import { Money } from '@/shared/money/money';
import { CorruptRecordError } from '@/shared/persistence/persistence.errors';

/**
 * Conversões usadas pelos mappers record ↔ domínio.
 */

/**
 * `bigint` do PostgreSQL chega como string (o `pg` não converte para não perder precisão). O domínio usa
 * `number` para versões; só aceitamos o valor se ele for um inteiro seguro (≤ 2^53 − 1).
 */
export function toSafeInteger(value: string, column: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new CorruptRecordError(`Column ${column} is not an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CorruptRecordError(`Column ${column} exceeds the safe integer range`);
  }
  return parsed;
}

/** Inverso de `toSafeInteger`: versões vão para colunas `bigint` como string decimal. */
export function fromSafeInteger(value: number, field: string): string {
  if (!Number.isSafeInteger(value)) {
    throw new CorruptRecordError(`Field ${field} is not a safe integer`);
  }
  return value.toString();
}

/** `NULL` do banco vira `undefined` no domínio (os opcionais do domínio não usam `null`). */
export function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/** `undefined` do domínio vira `NULL` no banco. */
export function undefinedToNull<T>(value: T | undefined): T | null {
  return value ?? null;
}

/** Monta `Money` a partir das duas colunas (`amount` `numeric(20,2)` como string + `currency` `char(3)`). */
export function moneyFromColumns(amount: string, currency: string): Money {
  return Money.from({ amount, currency });
}

/** Snapshot opcional: as duas colunas são nulas juntas (CHECK no schema) ou ambas presentes. */
export function optionalMoneyFromColumns(
  amount: string | null | undefined,
  currency: string | null | undefined,
  column: string,
): Money | undefined {
  if ((amount ?? null) === null && (currency ?? null) === null) {
    return undefined;
  }
  if (amount === null || amount === undefined || currency === null || currency === undefined) {
    throw new CorruptRecordError(`Columns ${column}_amount/${column}_currency must be both null or both set`);
  }
  return moneyFromColumns(amount, currency);
}

/** Valida limites/durações recebidos pelos repositórios (`LIMIT`, lease) antes de virarem SQL. */
export function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
