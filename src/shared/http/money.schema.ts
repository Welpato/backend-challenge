import { z } from 'zod';
import { Money } from '@/shared/money/money';
import { InvalidMoneyError } from '@/shared/money/money.errors';

/** Moeda ISO-4217: 3 letras maiúsculas (o mesmo CHECK da coluna `wallets.currency`). */
export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO-4217 code (3 uppercase letters)');

/**
 * `MoneyProps` de entrada → `Money`. `amount` passa pelo parse estrito de `Money.from`
 * (string com exatamente 2 casas, sem negativos, sem notação científica, até 18 dígitos inteiros);
 * `number` é rejeitado já no tipo. Campos extras são rejeitados.
 */
export const moneyInputSchema = z
  .object({
    amount: z.string('must be a decimal string like "25.00"'),
    currency: currencySchema,
  })
  .strict()
  .transform((props, ctx) => {
    try {
      return Money.from(props);
    } catch (error: unknown) {
      if (error instanceof InvalidMoneyError) {
        ctx.addIssue({ code: 'custom', message: error.message, path: ['amount'] });
        return z.NEVER;
      }
      throw error;
    }
  });
