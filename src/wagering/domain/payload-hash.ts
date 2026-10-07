import { canonicalJson } from '@/shared/canonical-json';
import { sha256Hex } from '@/shared/hashing';
import { Money } from '@/shared/money/money';
import type { MoneyProps } from '@/shared/money/money-props';

/**
 * Campos de negócio que identificam uma operação (ESPECIFICACAO.md §6). Header,
 * `idempotencyKey`, `messageId` e `occurredAt` ficam de fora: a mesma operação enviada por HTTP e
 * por SQS com a mesma key produz o mesmo hash (replay, não conflito).
 */
export interface PayloadHashFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money | MoneyProps;
  /** Ausente (`undefined`) é omitido do JSON canônico; nunca passe `null`. */
  referenceExternalTransactionId?: string | undefined;
}

/**
 * SHA-256 hex (64 caracteres minúsculos) do JSON canônico dos campos de §6.
 *
 * Os campos são copiados um a um, então propriedades extras do objeto recebido (ex.: um DTO com
 * `idempotencyKey`) nunca entram no hash.
 */
export function computePayloadHash(fields: PayloadHashFields): string {
  const money = fields.money instanceof Money ? fields.money.toJSON() : fields.money;
  return sha256Hex(
    canonicalJson({
      providerId: fields.providerId,
      externalTransactionId: fields.externalTransactionId,
      playerId: fields.playerId,
      walletId: fields.walletId,
      roundId: fields.roundId,
      gameId: fields.gameId,
      kind: fields.kind,
      money: { amount: money.amount, currency: money.currency },
      referenceExternalTransactionId: fields.referenceExternalTransactionId,
    }),
  );
}
