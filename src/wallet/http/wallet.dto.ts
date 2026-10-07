import { z } from 'zod';
import { currencySchema, moneyInputSchema } from '@/shared/http/money.schema';
import { Money } from '@/shared/money/money';
import { LEDGER_PAGE_DEFAULT_LIMIT, LEDGER_PAGE_MAX_LIMIT } from '@/wallet/application/get-ledger';
import { decodeLedgerCursor, InvalidLedgerCursorError } from '@/wallet/application/ledger-cursor';

const playerIdSchema = z
  .string('must be a string')
  .min(1, 'must not be empty')
  .max(255, 'must have at most 255 characters')
  .refine((value) => value.trim() === value, 'must not have leading or trailing whitespace');

/**
 * `POST /wallets`. `initialBalance` é opcional; sem ele a wallet abre com `0.00` e `currency` passa a ser
 * obrigatório (decisão da F08). Com os dois, a moeda tem que ser a mesma. Campos extras → 400.
 */
export const createWalletBodySchema = z
  .object({
    playerId: playerIdSchema,
    initialBalance: moneyInputSchema.optional(),
    currency: currencySchema.optional(),
  })
  .strict()
  .transform((body, ctx) => {
    const { playerId, initialBalance, currency } = body;
    if (initialBalance !== undefined) {
      if (currency !== undefined && currency !== initialBalance.currency) {
        ctx.addIssue({ code: 'custom', message: 'must match initialBalance.currency', path: ['currency'] });
        return z.NEVER;
      }
      return { playerId, initialBalance };
    }
    if (currency === undefined) {
      ctx.addIssue({ code: 'custom', message: 'is required when initialBalance is omitted', path: ['currency'] });
      return z.NEVER;
    }
    return { playerId, initialBalance: Money.zero(currency) };
  });

export type CreateWalletBody = z.output<typeof createWalletBodySchema>;

/** `:walletId` — só UUID; qualquer outra coisa é payload inválido (400), sem chegar ao banco. */
export const walletIdParamSchema = z.uuid('must be a UUID');

const limitSchema = z
  .string('must be a single integer')
  .regex(/^\d{1,4}$/, `must be an integer between 1 and ${LEDGER_PAGE_MAX_LIMIT}`)
  .transform((value) => Number.parseInt(value, 10))
  .pipe(z.number().int().min(1).max(LEDGER_PAGE_MAX_LIMIT, `must be at most ${LEDGER_PAGE_MAX_LIMIT}`));

/** `GET /wallets/:id/ledger?cursor&limit` → `{ afterVersion, limit }`. */
export const ledgerQuerySchema = z
  .object({
    cursor: z.string('must be a single cursor').optional(),
    limit: limitSchema.optional(),
  })
  .transform((query, ctx) => {
    let afterVersion = 0;
    if (query.cursor !== undefined) {
      try {
        afterVersion = decodeLedgerCursor(query.cursor);
      } catch (error: unknown) {
        if (!(error instanceof InvalidLedgerCursorError)) {
          throw error;
        }
        ctx.addIssue({ code: 'custom', message: 'is not a valid ledger cursor', path: ['cursor'] });
        return z.NEVER;
      }
    }
    return { afterVersion, limit: query.limit ?? LEDGER_PAGE_DEFAULT_LIMIT };
  });

export type LedgerQuery = z.output<typeof ledgerQuerySchema>;
