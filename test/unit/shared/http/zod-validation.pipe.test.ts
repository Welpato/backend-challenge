import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { RequestValidationError } from '@/shared/http/api-error';
import { moneyInputSchema } from '@/shared/http/money.schema';
import { ZodValidationPipe } from '@/shared/http/zod-validation.pipe';
import { Money } from '@/shared/money/money';

function validationError(run: () => unknown): RequestValidationError {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof RequestValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a RequestValidationError');
}

describe('ZodValidationPipe', () => {
  const schema = z.object({ name: z.string().min(1), nested: z.object({ n: z.number() }) }).strict();

  it('returns the parsed value', () => {
    const pipe = new ZodValidationPipe(schema);
    expect(pipe.transform({ name: 'a', nested: { n: 1 } }, { type: 'body' })).toEqual({ name: 'a', nested: { n: 1 } });
  });

  it('throws 400 VALIDATION_ERROR with every invalid field path', () => {
    const error = validationError(() =>
      new ZodValidationPipe(schema).transform({ name: '', nested: { n: 'x' }, extra: 1 }, { type: 'body' }),
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details?.map((detail) => detail.path).sort()).toEqual(['(root)', 'name', 'nested.n']);
  });

  it('prefixes paths with the route/query parameter name', () => {
    const error = validationError(() =>
      new ZodValidationPipe(z.uuid('must be a UUID')).transform('x', { type: 'param', data: 'walletId' }),
    );
    expect(error.details).toEqual([{ path: 'walletId', message: 'must be a UUID' }]);
  });
});

describe('moneyInputSchema', () => {
  it('turns valid MoneyProps into Money', () => {
    const money = moneyInputSchema.parse({ amount: '25.00', currency: 'BRL' });
    expect(money).toBeInstanceOf(Money);
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  const invalid: readonly [unknown, string][] = [
    [{ amount: 25, currency: 'BRL' }, 'amount'],
    [{ amount: '25', currency: 'BRL' }, 'amount'],
    [{ amount: '25.5', currency: 'BRL' }, 'amount'],
    [{ amount: '25.000', currency: 'BRL' }, 'amount'],
    [{ amount: '-25.00', currency: 'BRL' }, 'amount'],
    [{ amount: '2.5e1', currency: 'BRL' }, 'amount'],
    [{ amount: 'NaN', currency: 'BRL' }, 'amount'],
    [{ amount: '1234567890123456789.00', currency: 'BRL' }, 'amount'],
    [{ amount: '25.00', currency: 'brl' }, 'currency'],
    [{ amount: '25.00', currency: 'BR' }, 'currency'],
    [{ amount: '25.00' }, 'currency'],
    [{ amount: '25.00', currency: 'BRL', extra: 1 }, ''],
  ];

  for (const [input, path] of invalid) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      const result = moneyInputSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success && path !== '') {
        expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain(path);
      }
    });
  }
});
