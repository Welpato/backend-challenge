/**
 * Contexto de emissão de um evento de integração, montado por quem processa a operação.
 *
 * - `correlationId`: o mesmo da requisição/mensagem de entrada (rastreio ponta a ponta);
 * - `causationId`: id da mensagem ou evento que causou este (ex.: `messageId` do SQS), quando houver;
 * - `occurredAt`: instante do fato (normalmente o mesmo `at` usado na transição de domínio);
 * - `eventIdFactory`: gera o `eventId` (UUID v7 em produção; determinístico nos testes). O `eventId`
 *   é também o id da linha da outbox e o `MessageDeduplicationId` na publicação.
 */
export interface EventContext {
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
  eventIdFactory: () => string;
}
