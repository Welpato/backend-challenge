import type { InboxRepository } from '@/messaging/inbox/application/inbox.repository.port';
import { InboxPayloadConflictError } from '@/messaging/inbox/inbox.errors';
import { InboxMessage } from '@/messaging/inbox/inbox-message';
import type { Clock } from '@/shared/clock';
import { FailureCode } from '@/shared/failure-code';
import type { Money } from '@/shared/money/money';
import { addLogContext } from '@/shared/observability/correlation';
import { ConcurrencyInvariantError } from '@/shared/persistence/persistence.errors';
import { isForeignKeyViolation, isUniqueViolation, TransientDatabaseError } from '@/shared/persistence/pg-errors';
import type { UnitOfWork } from '@/shared/persistence/unit-of-work';
import { type KindHandler, type SubmittableKind, submittableKind } from '@/wagering/application/kind-handlers';
import type { PendingReferencePolicy } from '@/wagering/application/pending-reference-policy';
import type { ProcessingTelemetry } from '@/wagering/application/processing-telemetry.port';
import type { OutcomeEventContext, WagerOutcomeWriter } from '@/wagering/application/wager-outcome-writer';
import type { WagerTransactionRepository } from '@/wagering/application/wager-transaction.repository.port';
import type { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import { WagerTransaction } from '@/wagering/domain/wager-transaction';
import { IdempotencyConflictError } from '@/wagering/domain/wagering.errors';
import type { WalletRepository } from '@/wallet/application/wallet.repository.port';
import { WalletNotFoundError } from '@/wallet/domain/wallet.errors';

/** Operação de provedor (HTTP ou SQS), já com o payload validado na borda. */
export interface ProcessWagerTransactionCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  /** Header `Idempotency-Key` (HTTP) ou campo equivalente do envelope (SQS). Fonte da verdade da idempotência. */
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string | undefined;
}

export type ProcessingSource = 'http' | 'sqs';

/**
 * Passos 1 e 8 de §5 (inbox do consumidor SQS): a mensagem é registrada em `inbox_messages` na **mesma**
 * transação SQL do processamento, então "processada" e "efeito gravado" commitam juntos.
 */
export interface InboxReceipt {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
}

export interface ProcessContext {
  readonly source: ProcessingSource;
  readonly correlationId: string;
  /** `messageId` do SQS; ausente no HTTP (os eventos usam o id da transação). */
  readonly causationId?: string | undefined;
  readonly inbox?: InboxReceipt | undefined;
}

export type ProcessOutcome =
  | WagerTransactionStatus.Processed
  | WagerTransactionStatus.Rejected
  | WagerTransactionStatus.PendingReference
  | WagerTransactionStatus.Failed;

export interface ProcessResult {
  readonly transaction: WagerTransaction;
  /** Snapshot gravado na finalização (moeda da wallet); ausente em `PENDING_REFERENCE` e `FAILED`. */
  readonly balance: Money | undefined;
  readonly idempotentReplay: boolean;
  readonly outcome: ProcessOutcome;
  /**
   * Só SQS: a mesma mensagem (`consumerName`, `messageId`, mesmo hash) já tinha sido processada — nada foi
   * gravado nesta passada; `transaction` é a gravada pela primeira entrega (`idempotentReplay` também é `true`).
   */
  readonly inboxDuplicate: boolean;
}

/** FK `wager_transactions.wallet_id → wallets.id` (nome gerado pelo PostgreSQL na 0001_init). */
const WALLET_FOREIGN_KEY = 'wager_transactions_wallet_id_fkey';
/** Índice único parcial: uma reversão `PROCESSED` por referência (§2). */
const REVERSAL_ONCE_INDEX = 'ux_reversal_once';

/**
 * `ProcessWagerTransaction` (ESPECIFICACAO.md §5) — use case único de HTTP e SQS. Numa transação
 * `READ COMMITTED` com `lock_timeout`:
 *
 * 1. [SQS] `INSERT … ON CONFLICT DO NOTHING` na inbox `(consumerName, messageId)`. Conflito com o mesmo hash → a
 *    mensagem já foi processada (a linha só fica visível depois do commit que também gravou o efeito): devolve
 *    o resultado gravado com `inboxDuplicate`, sem efeito. Hash diferente → `InboxPayloadConflictError`
 *    (permanente, DLQ).
 * 2. `INSERT … ON CONFLICT DO NOTHING` da transação `PENDING`. Conflito → replay (mesmo hash: devolve o que
 *    está gravado, sem tocar na wallet) ou `IDEMPOTENCY_CONFLICT` / `EXTERNAL_ID_CONFLICT` (hash diferente,
 *    conforme a key bate ou não). Wallet inexistente → a FK recusa o INSERT → `WALLET_NOT_FOUND`, nada gravado.
 * 3. Lock da wallet (`FOR NO KEY UPDATE`) — sempre **depois** do insert (ordem de locks, §2); player e moeda
 *    conferidos → `REJECTED WALLET_PLAYER_MISMATCH` / `CURRENCY_MISMATCH`.
 * 4. Estratégia por kind (`kind-handlers.ts`), com `ReversalPolicy` quando há referência.
 * 5–7. `WagerOutcomeWriter`: saldo + ledger, transição, outbox. Referência ausente → `PENDING_REFERENCE`.
 * 8. [SQS] `inbox.markProcessed` — inclusive em replay e em rejeição de negócio (o resultado é terminal e o
 *    consumidor dá ack). Erros (conflito, wallet inexistente, falha transitória) desfazem tudo, inclusive a
 *    linha da inbox, e a mensagem pode ser reentregue ou ir para a DLQ.
 *
 * Retentativas: deadlock (`40P01`) é repetido **uma vez** quando a origem é HTTP (o SQS já reentrega);
 * violação do `ux_reversal_once` (corrida que o lock da wallet já deveria impedir) é repetida uma vez — na
 * segunda passada a consulta sob lock enxerga a reversão e responde `ALREADY_REVERSED`. Demais falhas
 * transitórias sobem como `TransientDatabaseError` (HTTP 503).
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly handlers: Readonly<Record<SubmittableKind, KindHandler>>,
    private readonly writer: WagerOutcomeWriter,
    private readonly pendingPolicy: PendingReferencePolicy,
    private readonly clock: Clock,
    private readonly inbox: InboxRepository,
    private readonly telemetry: ProcessingTelemetry,
  ) {}

  /**
   * Processa a operação e, depois do commit (ou da falha), registra métricas e o log estruturado do desfecho
   * (`ProcessingTelemetry`). Os identificadores conhecidos já vão para o contexto de log do fluxo.
   */
  async execute(command: ProcessWagerTransactionCommand, ctx: ProcessContext): Promise<ProcessResult> {
    const startedAt = performance.now();
    addLogContext({
      causationId: ctx.causationId,
      walletId: command.walletId,
      providerId: command.providerId,
      kind: command.kind,
    });
    try {
      const result = await this.executeWithRetries(command, ctx);
      this.telemetry.processed(result, ctx.source, performance.now() - startedAt);
      return result;
    } catch (error: unknown) {
      this.telemetry.processingFailed(error, command.kind, ctx.source, performance.now() - startedAt);
      throw error;
    }
  }

  private async executeWithRetries(
    command: ProcessWagerTransactionCommand,
    ctx: ProcessContext,
  ): Promise<ProcessResult> {
    let deadlockRetries = ctx.source === 'http' ? 1 : 0;
    let reversalRetries = 1;
    for (;;) {
      try {
        return await this.attempt(command, ctx);
      } catch (error: unknown) {
        this.telemetry.attemptFailed(error);
        if (error instanceof TransientDatabaseError && error.reason === 'deadlock' && deadlockRetries > 0) {
          deadlockRetries -= 1;
          continue;
        }
        if (isUniqueViolation(error, REVERSAL_ONCE_INDEX) && reversalRetries > 0) {
          reversalRetries -= 1;
          continue;
        }
        if (isForeignKeyViolation(error, WALLET_FOREIGN_KEY)) {
          throw new WalletNotFoundError(command.walletId);
        }
        throw error;
      }
    }
  }

  /** Uma passada completa numa transação nova (a transação de domínio é recriada a cada tentativa). */
  private async attempt(command: ProcessWagerTransactionCommand, ctx: ProcessContext): Promise<ProcessResult> {
    const now = this.clock.now();
    const tx = WagerTransaction.create({ ...command, correlationId: ctx.correlationId, at: now });
    return this.uow.run(async () => {
      const inboxMessage =
        ctx.inbox === undefined ? undefined : InboxMessage.receive({ ...ctx.inbox, receivedAt: now });
      if (inboxMessage !== undefined) {
        const duplicate = await this.receiveInboxMessage(inboxMessage, command);
        if (duplicate !== undefined) {
          return duplicate;
        }
      }
      const result = await this.process(tx, ctx, now);
      if (inboxMessage !== undefined) {
        inboxMessage.markProcessed(now);
        await this.inbox.markProcessed(inboxMessage);
      }
      return result;
    });
  }

  /**
   * Passo 1. Devolve o resultado gravado quando a mensagem é uma redelivery já processada; `undefined` quando é
   * nova (a linha da inbox foi inserida nesta transação).
   */
  private async receiveInboxMessage(
    message: InboxMessage,
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessResult | undefined> {
    const insertion = await this.inbox.insertIfAbsent(message);
    if (insertion.inserted) {
      return undefined;
    }
    const { existing } = insertion;
    if (existing.payloadHash !== message.payloadHash) {
      throw new InboxPayloadConflictError(message.consumerName, message.messageId);
    }
    // A linha só fica visível depois do commit que a marcou como processada (passo 8 na mesma transação).
    const stored = existing.isProcessed()
      ? await this.transactions.findByProviderExternalId(command.providerId, command.externalTransactionId)
      : undefined;
    if (stored === undefined) {
      throw new ConcurrencyInvariantError(
        `Inbox message ${message.messageId} is recorded, but its processed transaction is not visible`,
      );
    }
    return { ...resultOf(stored, true), inboxDuplicate: true };
  }

  /** Passos 2–7. */
  private async process(tx: WagerTransaction, ctx: ProcessContext, now: Date): Promise<ProcessResult> {
    const insertion = await this.transactions.insertIfAbsent(tx);
    if (!insertion.inserted) {
      return replayOrConflict(tx, insertion.existing);
    }
    const lockRequestedAt = performance.now();
    const wallet = await this.wallets.findByIdForUpdate(tx.walletId);
    this.telemetry.walletLockAcquired(performance.now() - lockRequestedAt);
    if (wallet === undefined) {
      throw new WalletNotFoundError(tx.walletId);
    }
    const events: OutcomeEventContext = { correlationId: ctx.correlationId, causationId: ctx.causationId ?? tx.id };
    if (wallet.playerId !== tx.playerId) {
      await this.writer.reject(tx, wallet, FailureCode.WALLET_PLAYER_MISMATCH, now, events);
    } else if (wallet.currency !== tx.money.currency) {
      await this.writer.reject(tx, wallet, FailureCode.CURRENCY_MISMATCH, now, events);
    } else {
      const decision = await this.handlers[submittableKind(tx)].decide(tx);
      if (decision.type === 'apply') {
        await this.writer.apply(tx, wallet, decision, now, events);
      } else if (decision.type === 'reject') {
        await this.writer.reject(tx, wallet, decision.code, now, events);
      } else {
        await this.writer.markPending(tx, this.pendingPolicy.nextAttemptAt(now, 0), now, events);
      }
      if (tx.status === WagerTransactionStatus.Processed) {
        // Atalho do reprocessador: quem esperava por esta transação é reavaliado já no próximo ciclo.
        await this.transactions.expediteDependents(tx.walletId, tx.providerId, tx.externalTransactionId);
      }
    }
    return resultOf(tx, false);
  }
}

/**
 * Conflito no INSERT. Mesmo payload (hash) → replay do resultado gravado, sem recalcular nada (regra 7.7).
 * Payload diferente → `IDEMPOTENCY_CONFLICT` se a key é a mesma; senão o conflito foi no par
 * `(providerId, externalTransactionId)` com outra key → `EXTERNAL_ID_CONFLICT`. Nada é gravado.
 */
function replayOrConflict(incoming: WagerTransaction, existing: WagerTransaction): ProcessResult {
  if (existing.matchesPayload(incoming.payloadHash)) {
    return resultOf(existing, true);
  }
  if (existing.idempotencyKey === incoming.idempotencyKey) {
    throw new IdempotencyConflictError(FailureCode.IDEMPOTENCY_CONFLICT);
  }
  throw new IdempotencyConflictError(FailureCode.EXTERNAL_ID_CONFLICT);
}

function resultOf(tx: WagerTransaction, idempotentReplay: boolean): ProcessResult {
  const outcome = tx.status;
  if (outcome === WagerTransactionStatus.Pending) {
    // PENDING nunca fica visível depois do commit (§12); chegar aqui é bug.
    throw new Error(`Transaction ${tx.id} is still PENDING after processing`);
  }
  const hasSnapshot = outcome === WagerTransactionStatus.Processed || outcome === WagerTransactionStatus.Rejected;
  return {
    transaction: tx,
    balance: hasSnapshot ? tx.balanceAfter : undefined,
    idempotentReplay,
    outcome,
    inboxDuplicate: false,
  };
}
