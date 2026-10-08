import type { OutboxMessage } from '@/messaging/outbox/outbox-message';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

/** Resultado por mensagem: publicada, ou falha com o motivo (texto para `last_error`). */
export type PublishResult =
  | { readonly messageId: string; readonly ok: true }
  | { readonly messageId: string; readonly ok: false; readonly error: string; readonly transient: boolean };

/**
 * Porta de publicação dos eventos da outbox. Publicação at-least-once: uma mensagem marcada `ok` foi aceita
 * pelo broker; a mesma mensagem pode ser publicada de novo (ex.: o processo morreu antes do commit) e o
 * consumidor deduplica pelo `eventId`.
 */
export interface EventPublisher {
  /** Publica o lote e devolve um resultado para **cada** mensagem (mesma ordem). Nunca lança por falha de envio. */
  publishBatch(messages: readonly OutboxMessage[]): Promise<PublishResult[]>;
}
