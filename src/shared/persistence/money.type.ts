import { type EntityProperty, type Platform, Type } from '@mikro-orm/core';

/** `NUMERIC(20,2)` no formato que o PostgreSQL devolve: até 18 dígitos inteiros e exatamente 2 casas. */
const NUMERIC_20_2 = /^-?(0|[1-9]\d{0,17})\.\d{2}$/;

export class InvalidMoneyColumnError extends Error {
  constructor(direction: 'read' | 'write') {
    super(`Invalid NUMERIC(20,2) value on ${direction}: expected a decimal string with exactly 2 places`);
    this.name = 'InvalidMoneyColumnError';
  }
}

/**
 * Tipo de coluna monetária do MikroORM: `numeric(20,2)` no banco ↔ `string` no record.
 *
 * O tipo **nunca** produz `number`: o driver `pg` devolve `numeric` como string (validado na F00) e
 * qualquer outra coisa (número, string com outra escala) é rejeitada em vez de convertida — converter
 * um `number` já seria tarde, a precisão poderia ter sido perdida. A conversão para `Money` (bigint de
 * centavos) acontece nos mappers, com `Money.from({ amount, currency })`, porque a moeda vem de outra
 * coluna.
 *
 * Valores negativos passam pelo tipo (o formato é o do `numeric`); quem barra saldo/valor negativo são os
 * CHECKs do schema e o domínio.
 */
export class MoneyAmountType extends Type<string, string> {
  override convertToDatabaseValue(value: string): string {
    return MoneyAmountType.assertNumeric(value, 'write');
  }

  override convertToJSValue(value: string): string {
    return MoneyAmountType.assertNumeric(value, 'read');
  }

  override compareAsType(): string {
    return 'string';
  }

  override get runtimeType(): string {
    return 'string';
  }

  override getColumnType(_prop: EntityProperty, _platform: Platform): string {
    return 'numeric(20,2)';
  }

  /**
   * Colunas monetárias anuláveis (`balance_after_amount`) também passam por aqui: `NULL` atravessa sem
   * conversão (a tipagem `Type<string, string>` mantém o record não-nulo onde a coluna é `NOT NULL`).
   */
  private static assertNumeric(value: unknown, direction: 'read' | 'write'): string {
    if (value === null) {
      return value as unknown as string;
    }
    if (typeof value !== 'string' || !NUMERIC_20_2.test(value)) {
      throw new InvalidMoneyColumnError(direction);
    }
    return value;
  }
}
