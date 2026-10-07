/**
 * JSON canônico usado no hash de payload (ESPECIFICACAO.md §6).
 *
 * Regras:
 * - chaves de objetos ordenadas recursivamente (ordem de code units UTF-16, como `Array#sort`);
 * - sem espaços;
 * - propriedades com valor `undefined` são omitidas;
 * - objetos com `toJSON()` (ex.: `Money`, `Date`) são serializados pelo resultado dele;
 * - arrays preservam a ordem; `undefined` dentro de array é rejeitado (não há representação sem ambiguidade);
 * - rejeitados: números não inteiros ou fora do intervalo seguro, `NaN`, `Infinity`, `bigint`,
 *   funções, símbolos, instâncias que não sejam objetos simples e referências circulares.
 *
 * Dinheiro trafega como string (`MoneyProps`), então nenhum valor monetário passa por `number` aqui.
 */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

interface WithToJson {
  toJSON(): unknown;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new CanonicalJsonError('Cannot serialize undefined');
  }
  return serialize(value, '$', new Set<object>());
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(`Unsupported number at ${path}: only safe integers are allowed`);
      }
      return JSON.stringify(value);
    case 'object':
      return value === null ? 'null' : serializeObject(value, path, ancestors);
    default:
      throw new CanonicalJsonError(`Unsupported value of type ${typeof value} at ${path}`);
  }
}

function serializeObject(value: object, path: string, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw new CanonicalJsonError(`Circular reference at ${path}`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return serializeArray(value, path, ancestors);
    }
    if (hasToJson(value)) {
      const replaced: unknown = value.toJSON();
      if (replaced === undefined) {
        throw new CanonicalJsonError(`toJSON() returned undefined at ${path}`);
      }
      return serialize(replaced, path, ancestors);
    }
    if (!isPlainObject(value)) {
      throw new CanonicalJsonError(`Unsupported object at ${path}: only plain objects are allowed`);
    }
    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member !== undefined) {
        members.push(`${JSON.stringify(key)}:${serialize(member, `${path}.${key}`, ancestors)}`);
      }
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(items: readonly unknown[], path: string, ancestors: Set<object>): string {
  const parts = items.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (item === undefined) {
      throw new CanonicalJsonError(`Unsupported undefined array item at ${itemPath}`);
    }
    return serialize(item, itemPath, ancestors);
  });
  return `[${parts.join(',')}]`;
}

function hasToJson(value: object): value is WithToJson {
  return typeof (value as Partial<WithToJson>).toJSON === 'function';
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
