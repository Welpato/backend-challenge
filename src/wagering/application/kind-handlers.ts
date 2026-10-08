import type { FailureCode } from '@/shared/failure-code';
import type { WagerTransactionRepository } from '@/wagering/application/wager-transaction.repository.port';
import { ReversalPolicy } from '@/wagering/domain/reversal-policy';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';
import { LedgerDirection } from '@/wallet/domain/ledger-direction';

/**
 * O que fazer com uma transação já validada contra a wallet (player e moeda conferidos):
 * - `apply`: aplicar; `direction` ausente = não move saldo (LOSS); `reference` = transação referenciada
 *   (o id interno dela vai para `referenceTransactionId`);
 * - `reject`: rejeição de negócio com o código;
 * - `pending`: a referência ainda não existe/não está pronta (regra 7.8).
 */
export type KindDecision =
  | { readonly type: 'apply'; readonly direction?: LedgerDirection; readonly reference?: WagerTransaction }
  | { readonly type: 'reject'; readonly code: FailureCode }
  | { readonly type: 'pending' };

/** Estratégia por kind. Roda **sob o lock da wallet** (ordem de locks, §2). */
export interface KindHandler {
  decide(tx: WagerTransaction): Promise<KindDecision>;
}

/**
 * Resolve a referência informada e aplica a `ReversalPolicy` (regras 7.2–7.5). A leitura da referência e
 * a consulta "já revertida" acontecem com o lock da wallet já tomado e **sem** `FOR UPDATE` nas linhas de
 * transação: tudo que pode mudar a referência ou criar uma reversão dela também passa pelo lock dessa
 * wallet (a referência válida é sempre da mesma wallet — senão é `REFERENCE_MISMATCH`).
 */
export async function decideWithReference(
  tx: WagerTransaction,
  transactions: WagerTransactionRepository,
): Promise<KindDecision> {
  const referenceExternalId = tx.referenceExternalTransactionId;
  if (referenceExternalId === undefined) {
    throw new Error(`Transaction ${tx.id} has no reference to resolve`);
  }
  const reference = await transactions.findReference(tx.providerId, referenceExternalId);
  const alreadyReversed = reference === undefined ? false : await transactions.hasProcessedReversal(reference.id);
  const decision = ReversalPolicy.evaluate(tx, reference, { alreadyReversed });
  switch (decision.outcome) {
    case 'PENDING':
      return { type: 'pending' };
    case 'REJECT':
      return { type: 'reject', code: decision.code };
    case 'APPLY':
      if (reference === undefined) {
        throw new Error('ReversalPolicy applied a transaction without its reference');
      }
      return decision.direction === undefined
        ? { type: 'apply', reference }
        : { type: 'apply', direction: decision.direction, reference };
  }
}

/**
 * BET, WIN e LOSS: sem referência, o efeito é direto (BET → débito, WIN → crédito, LOSS → nada); com
 * referência informada, passam pela `ReversalPolicy` como o WIN (decisões de 2026-10-07).
 */
class ResultKindHandler implements KindHandler {
  constructor(
    private readonly transactions: WagerTransactionRepository,
    private readonly direction: LedgerDirection | undefined,
  ) {}

  decide(tx: WagerTransaction): Promise<KindDecision> {
    if (tx.referenceExternalTransactionId !== undefined) {
      return decideWithReference(tx, this.transactions);
    }
    return Promise.resolve(
      this.direction === undefined ? { type: 'apply' } : { type: 'apply', direction: this.direction },
    );
  }
}

/**
 * REFUND e ROLLBACK: sempre têm referência (validado na criação). A `ReversalPolicy` decide a direção
 * (REFUND → crédito; ROLLBACK → inverso da referência), a reversão única e a referência pendente.
 */
class ReversalKindHandler implements KindHandler {
  constructor(private readonly transactions: WagerTransactionRepository) {}

  decide(tx: WagerTransaction): Promise<KindDecision> {
    return decideWithReference(tx, this.transactions);
  }
}

export type SubmittableKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

/** Kind de uma transação de provedor; OPENING nunca chega aos handlers (erro de programação). */
export function submittableKind(tx: WagerTransaction): SubmittableKind {
  if (tx.kind === WagerTransactionKind.Opening) {
    throw new Error('OPENING transactions are never processed by the kind handlers');
  }
  return tx.kind;
}

export function createKindHandlers(
  transactions: WagerTransactionRepository,
): Readonly<Record<SubmittableKind, KindHandler>> {
  const reversal = new ReversalKindHandler(transactions);
  return Object.freeze({
    [WagerTransactionKind.Bet]: new ResultKindHandler(transactions, LedgerDirection.Debit),
    [WagerTransactionKind.Win]: new ResultKindHandler(transactions, LedgerDirection.Credit),
    [WagerTransactionKind.Loss]: new ResultKindHandler(transactions, undefined),
    [WagerTransactionKind.Refund]: reversal,
    [WagerTransactionKind.Rollback]: reversal,
  });
}
