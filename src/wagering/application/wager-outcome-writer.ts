import type { OutboxRepository } from '@/messaging/outbox/application/outbox.repository.port';
import { OutboxMessage } from '@/messaging/outbox/outbox-message';
import type { EventContext } from '@/shared/events/event-context';
import type { FailureCode } from '@/shared/failure-code';
import { newUuidV7 } from '@/shared/ids';
import type { KindDecision } from '@/wagering/application/kind-handlers';
import type { WagerTransactionRepository } from '@/wagering/application/wager-transaction.repository.port';
import { WagerTransactionPendingReference } from '@/wagering/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '@/wagering/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '@/wagering/domain/events/wager-transaction-rejected';
import { ReversalPolicy } from '@/wagering/domain/reversal-policy';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';
import type { LedgerRepository } from '@/wallet/application/ledger.repository.port';
import type { WalletRepository } from '@/wallet/application/wallet.repository.port';
import { WalletBalanceChanged } from '@/wallet/domain/events/wallet-balance-changed';
import { LedgerDirection } from '@/wallet/domain/ledger-direction';
import type { Wallet } from '@/wallet/domain/wallet';
import { InsufficientFundsError } from '@/wallet/domain/wallet.errors';

/** Correlação dos eventos gravados na outbox para esta finalização. */
export interface OutcomeEventContext {
  readonly correlationId: string;
  /** `messageId` do SQS (F12) ou o id da própria transação. */
  readonly causationId: string;
}

export type ApplyDecision = Extract<KindDecision, { type: 'apply' }>;

/**
 * Passos 5–7 do fluxo de §5, compartilhados pelo `ProcessWagerTransaction` e pelo `ResolvePendingReference`.
 * Sempre chamado dentro da `UnitOfWork`, **com o lock da wallet já tomado** (`findByIdForUpdate`): mexe no
 * saldo, no ledger, na transação e na outbox na mesma transação SQL.
 */
export class WagerOutcomeWriter {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly outbox: OutboxRepository,
  ) {}

  /**
   * Aplica a decisão: se houver direção, débito/crédito na wallet (`UPDATE … WHERE version = esperada` +
   * lançamento no ledger) e `PROCESSED` com o saldo resultante; débito sem saldo vira `REJECTED` com
   * `INSUFFICIENT_FUNDS` (ou `REVERSAL_INSUFFICIENT_FUNDS` em reversões, regra 7.9), sem lançamento.
   * Eventos: `WagerTransactionProcessed` (+ `WalletBalanceChanged` quando o saldo muda) ou `Rejected`.
   */
  async apply(
    tx: WagerTransaction,
    wallet: Wallet,
    decision: ApplyDecision,
    now: Date,
    ctx: OutcomeEventContext,
  ): Promise<void> {
    const expectedVersion = wallet.version;
    let entry: ReturnType<Wallet['debit']> | undefined;
    if (decision.direction !== undefined) {
      try {
        entry =
          decision.direction === LedgerDirection.Debit
            ? wallet.debit(tx.id, tx.money, now)
            : wallet.credit(tx.id, tx.money, now);
      } catch (error: unknown) {
        if (error instanceof InsufficientFundsError) {
          await this.reject(tx, wallet, ReversalPolicy.insufficientFundsCodeFor(tx.kind), now, ctx);
          return;
        }
        throw error;
      }
      await this.wallets.updateBalance(wallet, expectedVersion);
      await this.ledger.append(entry);
    }
    tx.markProcessed(decision.reference?.id, wallet.balance, now);
    await this.transactions.save(tx);
    const events = eventContext(ctx, now);
    const messages = [OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, events), now)];
    if (entry !== undefined) {
      messages.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, events), now));
    }
    await this.outbox.enqueue(messages);
  }

  /** `REJECTED` com o saldo observado (moeda da wallet) como snapshot + `WagerTransactionRejected`. */
  async reject(tx: WagerTransaction, wallet: Wallet, code: FailureCode, now: Date, ctx: OutcomeEventContext) {
    tx.reject(code, wallet.balance, now);
    await this.transactions.save(tx);
    await this.outbox.enqueue([OutboxMessage.enqueue(WagerTransactionRejected.from(tx, eventContext(ctx, now)), now)]);
  }

  /**
   * Primeira vez sem referência pronta: `PENDING → PENDING_REFERENCE` com a próxima tentativa agendada +
   * `WagerTransactionPendingReference`. Reagendamentos do reprocessador não emitem evento (o provedor já
   * foi avisado; o próximo evento é o resultado final).
   */
  async markPending(tx: WagerTransaction, nextAttemptAt: Date, now: Date, ctx: OutcomeEventContext): Promise<void> {
    tx.markPendingReference(nextAttemptAt);
    await this.transactions.save(tx);
    await this.outbox.enqueue([
      OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, eventContext(ctx, now)), now),
    ]);
  }
}

function eventContext(ctx: OutcomeEventContext, now: Date): EventContext {
  return { correlationId: ctx.correlationId, causationId: ctx.causationId, occurredAt: now, eventIdFactory: newUuidV7 };
}
