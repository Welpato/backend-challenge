import { z } from 'zod';
import { canonicalJson } from '@/shared/canonical-json';
import { DomainError } from '@/shared/errors/domain-error';
import { FailureCode } from '@/shared/failure-code';
import { sha256Hex } from '@/shared/hashing';
import type { ProcessWagerTransactionCommand } from '@/wagering/application/process-wager-transaction';
import { IDEMPOTENCY_KEY_MAX_LENGTH, submitTransactionBodySchema } from '@/wagering/http/wagering.dto';

/** Único `type` aceito na `wager-transactions.fifo` (DESAFIO.md §10). */
export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

/**
 * `messageId`: mesmo charset aceito para `correlationId` (vira o correlationId quando a mensagem não traz um) e
 * para `MessageDeduplicationId` do SQS (até 128 caracteres).
 */
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Motivo de rejeição do envelope — vai no atributo `failureReason` da DLQ e no label da métrica. */
export type EnvelopeFailureReason = 'INVALID_ENVELOPE' | 'UNKNOWN_MESSAGE_TYPE' | typeof FailureCode.VALIDATION_ERROR;

/** Mensagem que não pode ser processada nunca (JSON inválido, `type` desconhecido, `data` inválido). Permanente. */
export class InvalidEnvelopeError extends DomainError {
  constructor(
    readonly reason: EnvelopeFailureReason,
    message: string,
    /** `messageId` do envelope, quando chegou a ser lido (vai para o atributo `originalMessageId` da DLQ). */
    readonly envelopeMessageId?: string,
  ) {
    super(reason, message);
  }
}

/**
 * `data` = o mesmo corpo do `POST /wagering/transactions` (mesmo schema, mesmas regras de borda) + a
 * `idempotencyKey`, que no HTTP vem no header. Regras por kind (OPENING, valor > 0, referência obrigatória)
 * continuam no domínio e chegam ao consumidor como erro de contrato → DLQ.
 */
const envelopeDataSchema = submitTransactionBodySchema.extend({
  idempotencyKey: z
    .string('must be a string')
    .min(1, 'must not be empty')
    .max(IDEMPOTENCY_KEY_MAX_LENGTH, `must have at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`)
    .refine((value) => value.trim() === value, 'must not have leading or trailing whitespace'),
});

/** Cabeçalho do envelope, validado antes do `data` para distinguir `type` desconhecido de payload inválido. */
const envelopeHeaderSchema = z.object({
  messageId: z.string().regex(MESSAGE_ID_PATTERN, 'must match [A-Za-z0-9._:-]{1,128}'),
  type: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  data: z.unknown(),
});

const envelopeSchema = envelopeHeaderSchema
  .extend({ type: z.literal(WAGER_TRANSACTION_REQUESTED), data: envelopeDataSchema })
  .strict();

export interface WagerTransactionRequestedEnvelope {
  readonly messageId: string;
  readonly type: typeof WAGER_TRANSACTION_REQUESTED;
  readonly occurredAt: string;
  readonly command: ProcessWagerTransactionCommand;
  /**
   * SHA-256 do envelope canônico (`type`, `occurredAt`, `data`) — gravado na inbox. A mesma mensagem reentregue
   * tem o mesmo hash; o mesmo `messageId` com outro conteúdo é conflito (DLQ).
   */
  readonly payloadHash: string;
}

function describeIssues(error: z.ZodError): string {
  // Só caminhos e mensagens do zod — nunca o valor recebido (dinheiro não vai para log nem para a DLQ).
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * Lê o corpo de uma mensagem da `wager-transactions.fifo` (DESAFIO.md §10). Lança `InvalidEnvelopeError`:
 * `INVALID_ENVELOPE` (JSON/cabeçalho inválido), `UNKNOWN_MESSAGE_TYPE` ou `VALIDATION_ERROR` (`data`).
 */
export function parseWagerEnvelope(body: string | undefined): WagerTransactionRequestedEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? '');
  } catch {
    throw new InvalidEnvelopeError('INVALID_ENVELOPE', 'Message body is not valid JSON');
  }
  const header = envelopeHeaderSchema.safeParse(raw);
  if (!header.success) {
    throw new InvalidEnvelopeError('INVALID_ENVELOPE', `Invalid envelope: ${describeIssues(header.error)}`);
  }
  const { messageId, type } = header.data;
  if (type !== WAGER_TRANSACTION_REQUESTED) {
    throw new InvalidEnvelopeError('UNKNOWN_MESSAGE_TYPE', `Unknown message type ${type}`, messageId);
  }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidEnvelopeError(
      FailureCode.VALIDATION_ERROR,
      `Invalid message data: ${describeIssues(parsed.error)}`,
      messageId,
    );
  }
  const { data, occurredAt } = parsed.data;
  const { idempotencyKey, ...operation } = data;
  return {
    messageId,
    type: WAGER_TRANSACTION_REQUESTED,
    occurredAt,
    command: { ...operation, idempotencyKey },
    payloadHash: sha256Hex(canonicalJson({ type, occurredAt, data })),
  };
}
