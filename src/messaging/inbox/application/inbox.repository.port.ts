import type { InboxMessage } from '@/messaging/inbox/inbox-message';

export const INBOX_REPOSITORY = Symbol('INBOX_REPOSITORY');

export type InboxInsertResult =
  | { readonly inserted: true }
  | { readonly inserted: false; readonly existing: InboxMessage };

/** Porta da inbox do consumidor SQS. Todas as operações rodam dentro de uma `UnitOfWork`. */
export interface InboxRepository {
  /** `INSERT … ON CONFLICT DO NOTHING` na PK `(consumer_name, message_id)`; em conflito devolve a existente. */
  insertIfAbsent(message: InboxMessage): Promise<InboxInsertResult>;
  /** Grava `processed_at` (a mensagem já deve ter passado por `markProcessed` no domínio). */
  markProcessed(message: InboxMessage): Promise<void>;
}
