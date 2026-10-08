import type { Clock } from '@/shared/clock';
import { FailureCode } from '@/shared/failure-code';
import { newUuidV7 } from '@/shared/ids';
import { addLogContext } from '@/shared/observability/correlation';
import { isUniqueViolation } from '@/shared/persistence/pg-errors';
import type { UnitOfWork } from '@/shared/persistence/unit-of-work';
import { type KindHandler, type SubmittableKind, submittableKind } from '@/wagering/application/kind-handlers';
import type { PendingReferencePolicy } from '@/wagering/application/pending-reference-policy';
import type { ProcessingTelemetry } from '@/wagering/application/processing-telemetry.port';
import type { OutcomeEventContext, WagerOutcomeWriter } from '@/wagering/application/wager-outcome-writer';
import type { WagerTransactionRepository } from '@/wagering/application/wager-transaction.repository.port';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';
import type { WalletRepository } from '@/wallet/application/wallet.repository.port';
import type { Wallet } from '@/wallet/domain/wallet';

/**
 * Resultado de uma tentativa: `skipped` (não está mais pendente ou não existe), `processed`/`rejected`
 * (referência resolvida), `rescheduled` (ainda sem referência, nova tentativa agendada), `expired`
 * (TTL/tentativas esgotados → `REJECTED REFERENCE_NOT_FOUND`), `failed` (erros de infraestrutura esgotados).
 */
export type ResolveOutcome = 'skipped' | 'processed' | 'rejected' | 'rescheduled' | 'expired' | 'failed';

const REVERSAL_ONCE_INDEX = 'ux_reversal_once';

/** Desfecho + estado final da transação (para métricas/log depois do commit). */
interface Resolution {
  readonly outcome: ResolveOutcome;
  readonly tx: WagerTransaction | undefined;
}

/**
 * Caminho "resolver pendente" do reprocessador (ESPECIFICACAO.md §8), uma transação por id:
 * 1. lê a transação sem lock só para saber a wallet; se já não está `PENDING_REFERENCE`, sai;
 * 2. **lock da wallet** e releitura da transação (outra instância pode tê-la resolvido nesse meio-tempo);
 * 3. reavalia a referência com a mesma estratégia por kind do processamento normal;
 * 4. resolvida → aplica/rejeita (mesmos eventos do fluxo síncrono); ainda pendente → reagenda com backoff
 *    (`attempts++`, sem evento) ou, esgotado o limite/TTL, `REJECTED REFERENCE_NOT_FOUND` + `Rejected`.
 *
 * Player e moeda já foram conferidos quando a transação ficou pendente (são imutáveis), então não são
 * reavaliados. Idempotente: rodar duas vezes para o mesmo id (dois reprocessadores, lease vencida) aplica
 * no máximo uma vez — a segunda passada encontra a linha terminal e sai.
 */
export class ResolvePendingReference {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly handlers: Readonly<Record<SubmittableKind, KindHandler>>,
    private readonly writer: WagerOutcomeWriter,
    private readonly policy: PendingReferencePolicy,
    private readonly clock: Clock,
    private readonly telemetry: ProcessingTelemetry,
  ) {}

  async execute(transactionId: string): Promise<ResolveOutcome> {
    const startedAt = performance.now();
    let resolution: Resolution;
    try {
      resolution = await this.uow.run(() => this.resolve(transactionId));
    } catch (error: unknown) {
      this.telemetry.attemptFailed(error);
      // Corrida com outra reversão da mesma referência que o lock da wallet já deveria impedir: na segunda
      // passada a consulta "já revertida" enxerga a vencedora e a transação vira `ALREADY_REVERSED`.
      if (!isUniqueViolation(error, REVERSAL_ONCE_INDEX)) {
        throw error;
      }
      resolution = await this.uow.run(() => this.resolve(transactionId));
    }
    this.telemetry.pendingResolved(transactionId, resolution.outcome, resolution.tx, performance.now() - startedAt);
    return resolution.outcome;
  }

  /**
   * Erro inesperado (não de negócio, não transitório) ao resolver: conta como tentativa — reagenda com
   * backoff ou, esgotado o limite/TTL, `FAILED PROCESSING_FAILED` (auditável; sem evento, a lista mínima de
   * eventos não cobre FAILED). Evita que uma linha problemática volte a cada lease para sempre.
   */
  async recordFailure(transactionId: string): Promise<ResolveOutcome> {
    const startedAt = performance.now();
    const resolution = await this.uow.run(async (): Promise<Resolution> => {
      const locked = await this.lockPending(transactionId);
      if (locked === undefined) {
        return { outcome: 'skipped', tx: undefined };
      }
      const { tx } = locked;
      const now = this.clock.now();
      if (this.policy.isExhausted(tx.createdAt, tx.attempts, now)) {
        tx.fail(FailureCode.PROCESSING_FAILED, now);
        await this.transactions.save(tx);
        return { outcome: 'failed', tx };
      }
      tx.scheduleNextReferenceAttempt(this.policy.nextAttemptAt(now, tx.attempts + 1));
      await this.transactions.save(tx);
      return { outcome: 'rescheduled', tx };
    });
    this.telemetry.pendingResolved(transactionId, resolution.outcome, resolution.tx, performance.now() - startedAt);
    return resolution.outcome;
  }

  private async resolve(transactionId: string): Promise<Resolution> {
    const locked = await this.lockPending(transactionId);
    if (locked === undefined) {
      return { outcome: 'skipped', tx: undefined };
    }
    const { tx, wallet } = locked;
    const now = this.clock.now();
    const events: OutcomeEventContext = { correlationId: tx.correlationId ?? newUuidV7(), causationId: tx.id };
    const decision = await this.handlers[submittableKind(tx)].decide(tx);
    if (decision.type === 'apply') {
      await this.writer.apply(tx, wallet, decision, now, events);
      if (tx.status !== WagerTransactionStatus.Processed) {
        return { outcome: 'rejected', tx };
      }
      await this.transactions.expediteDependents(tx.walletId, tx.providerId, tx.externalTransactionId);
      return { outcome: 'processed', tx };
    }
    if (decision.type === 'reject') {
      await this.writer.reject(tx, wallet, decision.code, now, events);
      return { outcome: 'rejected', tx };
    }
    if (this.policy.isExhausted(tx.createdAt, tx.attempts, now)) {
      await this.writer.reject(tx, wallet, FailureCode.REFERENCE_NOT_FOUND, now, events);
      return { outcome: 'expired', tx };
    }
    tx.scheduleNextReferenceAttempt(this.policy.nextAttemptAt(now, tx.attempts + 1));
    await this.transactions.save(tx);
    return { outcome: 'rescheduled', tx };
  }

  /** Leitura sem lock → lock da wallet → releitura. `undefined` se a transação não está mais pendente. */
  private async lockPending(transactionId: string): Promise<{ tx: WagerTransaction; wallet: Wallet } | undefined> {
    const snapshot = await this.transactions.findById(transactionId);
    if (snapshot === undefined || snapshot.status !== WagerTransactionStatus.PendingReference) {
      return undefined;
    }
    addLogContext({
      correlationId: snapshot.correlationId,
      causationId: snapshot.id,
      transactionId: snapshot.id,
      walletId: snapshot.walletId,
      providerId: snapshot.providerId,
      kind: snapshot.kind,
    });
    const lockRequestedAt = performance.now();
    const wallet = await this.wallets.findByIdForUpdate(snapshot.walletId);
    this.telemetry.walletLockAcquired(performance.now() - lockRequestedAt);
    if (wallet === undefined) {
      throw new Error(`Wallet ${snapshot.walletId} of pending transaction ${transactionId} does not exist`);
    }
    const tx = await this.transactions.findById(transactionId);
    if (tx === undefined || tx.status !== WagerTransactionStatus.PendingReference) {
      return undefined;
    }
    return { tx, wallet };
  }
}
