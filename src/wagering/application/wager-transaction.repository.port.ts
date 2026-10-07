import type { WagerTransaction } from '@/wagering/domain/wager-transaction';

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');

export type InsertIfAbsentResult =
  | { readonly inserted: true }
  | { readonly inserted: false; readonly existing: WagerTransaction };

/** Porta de persistência das transações de aposta. Todas as operações rodam dentro de uma `UnitOfWork`. */
export interface WagerTransactionRepository {
  /**
   * `INSERT … ON CONFLICT DO NOTHING`. Duplicata concorrente espera no índice único até o vencedor
   * commitar. Em conflito, devolve a linha existente — buscada pela `idempotency_key` e, se não houver,
   * pelo par `(provider_id, external_transaction_id)`. Quem decide replay × conflito é o use case
   * (`existing.matchesPayload`, comparação de key).
   */
  insertIfAbsent(tx: WagerTransaction): Promise<InsertIfAbsentResult>;
  /** UPDATE do estado mutável (status, referência interna, falha, snapshot, tentativas, agenda). */
  save(tx: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Transação referenciada por `(providerId, referenceExternalTransactionId)`. Sem lock (ordem de locks, §2). */
  findReference(providerId: string, referenceExternalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Existe REFUND/ROLLBACK `PROCESSED` apontando para `referenceId`? Consultar sob o lock da wallet. */
  hasProcessedReversal(referenceId: string): Promise<boolean>;
  /**
   * Reivindica até `limit` transações `PENDING_REFERENCE` vencidas (`FOR UPDATE SKIP LOCKED`) e empurra o
   * `next_attempt_at` delas para `agora + leaseMs` (lease): outra instância não as pega até lá. Devolve os ids.
   */
  claimDuePendingReferences(limit: number, leaseMs: number): Promise<string[]>;
}
