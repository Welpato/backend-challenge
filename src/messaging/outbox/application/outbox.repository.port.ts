import type { OutboxMessage } from '@/messaging/outbox/outbox-message';

export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');

export interface OutboxStats {
  /** Mensagens ainda não publicadas. */
  readonly pending: number;
  /** `occurred_at` da não publicada mais antiga; `undefined` sem pendentes. */
  readonly oldestPendingOccurredAt: Date | undefined;
  /** Idade da mais antiga em segundos (0 sem pendentes) — base do `outbox_lag_seconds`. */
  readonly oldestPendingAgeSeconds: number;
}

/** Porta da outbox transacional. Todas as operações rodam dentro de uma `UnitOfWork`. */
export interface OutboxRepository {
  /** INSERT das mensagens na transação do chamador (mesmo commit da mudança de estado). */
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
  /**
   * `SELECT … WHERE published_at IS NULL AND next_attempt_at <= agora ORDER BY occurred_at LIMIT n
   * FOR UPDATE SKIP LOCKED`: as linhas ficam travadas até o fim da transação do chamador, então
   * publishers concorrentes recebem conjuntos disjuntos.
   */
  claimDue(limit: number): Promise<OutboxMessage[]>;
  /** UPDATE do estado de publicação (`attempts`, `next_attempt_at`, `published_at`, `last_error`). */
  save(message: OutboxMessage): Promise<void>;
  stats(): Promise<OutboxStats>;
  /** Pendentes com `attempts > threshold` — base do alerta de publicação travada (F11). */
  countPendingOverAttempts(threshold: number): Promise<number>;
}
