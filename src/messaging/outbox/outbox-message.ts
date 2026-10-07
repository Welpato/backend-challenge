import { type BackoffOptions, nextAttemptAt as computeNextAttemptAt, OUTBOX_BACKOFF } from '@/messaging/outbox/backoff';
import { InvalidOutboxOperationError } from '@/messaging/outbox/outbox.errors';
import { deepFreeze } from '@/shared/deep-freeze';
import type { IntegrationEvent } from '@/shared/events/integration-event';

/** Tamanho máximo guardado de `lastError` (texto de diagnóstico, não precisa ser completo). */
export const OUTBOX_LAST_ERROR_MAX_LENGTH = 1_000;

/** Estado persistido em `outbox_messages` (ESPECIFICACAO.md §4). */
export interface OutboxMessageState {
  /** = `eventId`. */
  id: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  /** Envelope serializado do evento (`IntegrationEvent#toJSON()`). */
  payload: Readonly<Record<string, unknown>>;
  correlationId?: string | undefined;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date | undefined;
  lastError?: string | undefined;
}

/** Jitter do reagendamento; injetável para testes determinísticos. */
export type RetryJitter = Pick<BackoffOptions, 'jitterRatio' | 'random'>;

/**
 * Evento pendente de publicação, gravado na **mesma transação SQL** da alteração financeira
 * (outbox transacional). O publisher (F11) pega as linhas vencidas, publica e chama
 * `markPublished`; em falha, `scheduleRetry` adia com backoff exponencial — nunca descarta.
 *
 * `payload`, `eventType`, `aggregateId` e o id são imutáveis (o payload é congelado em
 * profundidade); só `attempts`, `nextAttemptAt`, `publishedAt` e `lastError` mudam.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly eventVersion: number,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly correlationId: string | undefined,
    private readonly _occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  /** Novo registro para o evento, publicável a partir de `now`. O id da linha é o `eventId`. */
  static enqueue(event: IntegrationEvent<unknown>, now: Date): OutboxMessage {
    OutboxMessage.assertValidDate(now, 'now');
    const payload = deepFreeze(event.toJSON() as unknown as Record<string, unknown>);
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.version,
      payload,
      event.correlationId,
      event.occurredAt,
      0,
      OutboxMessage.copy(now),
      undefined,
      undefined,
    );
  }

  /** Reconstrução a partir da persistência — não revalida regras. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.eventVersion,
      deepFreeze(state.payload),
      state.correlationId,
      OutboxMessage.copy(state.occurredAt),
      state.attempts,
      OutboxMessage.copy(state.nextAttemptAt),
      state.publishedAt === undefined ? undefined : OutboxMessage.copy(state.publishedAt),
      state.lastError,
    );
  }

  get occurredAt(): Date {
    return OutboxMessage.copy(this._occurredAt);
  }

  /** Falhas de publicação até agora (contador, não dinheiro). */
  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return OutboxMessage.copy(this._nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt === undefined ? undefined : OutboxMessage.copy(this._publishedAt);
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pendente e com `nextAttemptAt <= now`. */
  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  /** Publicada com sucesso. Publicar de novo uma mensagem já publicada é erro de programação. */
  markPublished(at: Date): void {
    this.assertPending('mark as published');
    OutboxMessage.assertValidDate(at, 'publishedAt');
    this._publishedAt = OutboxMessage.copy(at);
  }

  /**
   * Falha de publicação: incrementa `attempts` e agenda `nextAttemptAt = now + min(2^attempts × 1s, 5 min)`
   * (com `attempts` já incrementado: 2s, 4s, 8s… até 5 min), menos o jitter. Guarda o erro truncado.
   */
  scheduleRetry(now: Date, error: string, jitter: RetryJitter = {}): void {
    this.assertPending('schedule a retry for');
    OutboxMessage.assertValidDate(now, 'now');
    const attempts = this._attempts + 1;
    const next = computeNextAttemptAt(now, attempts, { ...OUTBOX_BACKOFF, ...jitter });
    this._attempts = attempts;
    this._nextAttemptAt = next;
    this._lastError = error.slice(0, OUTBOX_LAST_ERROR_MAX_LENGTH);
  }

  private assertPending(action: string): void {
    if (!this.isPending()) {
      throw new InvalidOutboxOperationError(`Cannot ${action} an outbox message that was already published`);
    }
  }

  private static assertValidDate(date: Date, field: string): void {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new InvalidOutboxOperationError(`Invalid outbox message: ${field} must be a valid date`);
    }
  }

  private static copy(date: Date): Date {
    return new Date(date.getTime());
  }
}
