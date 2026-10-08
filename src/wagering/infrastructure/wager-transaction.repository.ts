import { LockMode } from '@mikro-orm/core';
import type { Clock } from '@/shared/clock';
import { ConcurrencyInvariantError } from '@/shared/persistence/persistence.errors';
import { UNTRACKED } from '@/shared/persistence/read-options';
import { assertPositiveInteger } from '@/shared/persistence/record-conversion';
import type { UnitOfWork } from '@/shared/persistence/unit-of-work';
import type {
  InsertIfAbsentResult,
  WagerTransactionRepository,
} from '@/wagering/application/wager-transaction.repository.port';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';
import { WagerTransactionMapper } from '@/wagering/infrastructure/wager-transaction.mapper';
import { WagerTransactionRecord } from '@/wagering/infrastructure/wager-transaction.record';

/**
 * `WagerTransactionRepository` sobre o MikroORM. Usa o `EntityManager` da `UnitOfWork` corrente.
 *
 * Nunca trava linhas de transação com `FOR UPDATE` no caminho normal (ordem de locks, §2): a serialização
 * é pelo lock da wallet. A única exceção é `claimDuePendingReferences`, que usa `SKIP LOCKED` (nunca espera).
 */
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * `ON CONFLICT DO NOTHING` sem alvo cobre a PK, a `idempotency_key` e o par provider/external id.
   * Em READ COMMITTED, uma duplicata concorrente espera no índice único até o vencedor commitar; como o
   * SELECT seguinte é outro statement (snapshot novo), a linha do vencedor já está visível. Se o vencedor
   * abortar, este INSERT entra normalmente.
   */
  async insertIfAbsent(tx: WagerTransaction): Promise<InsertIfAbsentResult> {
    const rows = await this.uow.em
      .createQueryBuilder(WagerTransactionRecord)
      .insert(WagerTransactionMapper.toRecord(tx))
      .onConflict()
      .ignore()
      .returning('id')
      .execute('all');
    if (rows.length === 1) {
      return { inserted: true };
    }
    const existing =
      (await this.findOneBy({ idempotencyKey: tx.idempotencyKey })) ??
      (await this.findByProviderExternalId(tx.providerId, tx.externalTransactionId));
    if (existing === undefined) {
      throw new ConcurrencyInvariantError(
        `Insert of wager transaction ${tx.id} was skipped by a conflict, but no conflicting row is visible`,
      );
    }
    return { inserted: false, existing };
  }

  async save(tx: WagerTransaction): Promise<void> {
    const affected = await this.uow.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id },
      WagerTransactionMapper.toStateColumns(tx, this.clock.now()),
    );
    if (affected !== 1) {
      throw new ConcurrencyInvariantError(`Wager transaction ${tx.id} does not exist`);
    }
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ id });
  }

  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ providerId, externalTransactionId });
  }

  /** A referência é a transação do mesmo provider cujo `external_transaction_id` é o referenciado. */
  findReference(providerId: string, referenceExternalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ providerId, externalTransactionId: referenceExternalTransactionId });
  }

  async hasProcessedReversal(referenceId: string): Promise<boolean> {
    const count = await this.uow.em.count(WagerTransactionRecord, {
      referenceTransactionId: referenceId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  /**
   * Duas etapas na transação do chamador: `SELECT … FOR UPDATE SKIP LOCKED` (as linhas que outra instância
   * já travou são puladas) e `UPDATE next_attempt_at = agora + lease`. Depois do commit, a lease impede
   * que outra instância pegue as mesmas linhas até ela vencer.
   */
  async claimDuePendingReferences(limit: number, leaseMs: number): Promise<string[]> {
    assertPositiveInteger(limit, 'limit');
    assertPositiveInteger(leaseMs, 'leaseMs');
    const now = this.clock.now();
    const due = await this.uow.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
      {
        ...UNTRACKED,
        fields: ['id'],
        orderBy: { nextAttemptAt: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
      },
    );
    const ids = due.map((record) => record.id);
    if (ids.length > 0) {
      await this.uow.em.nativeUpdate(
        WagerTransactionRecord,
        { id: { $in: ids } },
        { nextAttemptAt: new Date(now.getTime() + leaseMs), updatedAt: now },
      );
    }
    return ids;
  }

  /**
   * Só linhas da wallet cujo lock o chamador já tem: uma referência válida é sempre da mesma wallet (senão é
   * `REFERENCE_MISMATCH`), então nenhuma linha de outra wallet é tocada e a ordem de locks (§2) se mantém.
   * `next_attempt_at > agora` evita reescrever linhas já vencidas. Uma linha em lease antecipada pode ser
   * reivindicada de novo — inofensivo: a resolução relê a linha sob o lock da wallet e ignora se já saiu de pendente.
   */
  async expediteDependents(walletId: string, providerId: string, externalTransactionId: string): Promise<number> {
    const now = this.clock.now();
    return this.uow.em.nativeUpdate(
      WagerTransactionRecord,
      {
        walletId,
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: WagerTransactionStatus.PendingReference,
        nextAttemptAt: { $gt: now },
      },
      { nextAttemptAt: now, updatedAt: now },
    );
  }

  countPendingReferences(): Promise<number> {
    return this.uow.em.count(WagerTransactionRecord, { status: WagerTransactionStatus.PendingReference });
  }

  private async findOneBy(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await this.uow.em.findOne(WagerTransactionRecord, where, UNTRACKED);
    return record === null ? undefined : WagerTransactionMapper.toDomain(record);
  }
}
