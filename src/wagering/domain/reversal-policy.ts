import { FailureCode } from '@/shared/failure-code';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';
import { InvalidWagerTransactionError } from '@/wagering/domain/wagering.errors';
import type { LedgerDirection } from '@/wallet/domain/ledger-direction';

export type ReversalDecision =
  /** `direction` ausente quando a operação não move saldo (LOSS com referência). */
  | { readonly outcome: 'APPLY'; readonly direction?: LedgerDirection }
  | { readonly outcome: 'PENDING' }
  | { readonly outcome: 'REJECT'; readonly code: FailureCode };

export interface ReversalContext {
  /**
   * Já existe REFUND/ROLLBACK `PROCESSED` apontando para a referência (lido sob o lock da wallet).
   * Vale para todas as operações com referência: uma reversão não acontece duas vezes (§2,
   * `ux_reversal_once`) e WIN/BET/LOSS que apontam para uma BET já revertida são rejeitados (decisão
   * do Wesley, 2026-10-07).
   */
  alreadyReversed?: boolean;
}

/**
 * Kinds de referência aceitos por kind de operação (regra 7.3). WIN referencia a BET da rodada; BET e
 * LOSS com referência são validados como o WIN (decisão do Wesley, 2026-10-07).
 */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>> =
  Object.freeze({
    [WagerTransactionKind.Refund]: Object.freeze([WagerTransactionKind.Bet]),
    [WagerTransactionKind.Rollback]: Object.freeze([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
    ]),
    [WagerTransactionKind.Win]: Object.freeze([WagerTransactionKind.Bet]),
    [WagerTransactionKind.Bet]: Object.freeze([WagerTransactionKind.Bet]),
    [WagerTransactionKind.Loss]: Object.freeze([WagerTransactionKind.Bet]),
  });

const PENDING: ReversalDecision = Object.freeze({ outcome: 'PENDING' });

function reject(code: FailureCode): ReversalDecision {
  return Object.freeze({ outcome: 'REJECT', code });
}

/**
 * Serviço de domínio que valida uma operação com referência (REFUND, ROLLBACK, ou WIN/BET/LOSS com
 * `referenceExternalTransactionId`) contra a transação referenciada — regras 7.2–7.5 e §3.7.
 * WIN, BET e LOSS seguem as mesmas regras: só referenciam BET e não conferem valor.
 *
 * Precedência das regras (a primeira que falha decide):
 * 1. referência inexistente/invisível ou em `PENDING`/`PENDING_REFERENCE` → `PENDING` (regra 7.8);
 * 2. referência `REJECTED`/`FAILED` → `REFERENCE_NOT_PROCESSED`;
 * 3. kind da referência não permitido → `REFERENCE_KIND_NOT_ALLOWED`;
 * 4. provider, player, wallet, moeda ou rodada diferentes → `REFERENCE_MISMATCH`;
 * 5. valor diferente (só REFUND/ROLLBACK; reversão parcial fora de escopo) → `REFERENCE_AMOUNT_MISMATCH`;
 * 6. referência já revertida → `ALREADY_REVERSED` (para REFUND/ROLLBACK é a reversão única; para
 *    WIN/BET/LOSS, a BET referenciada foi cancelada);
 * senão `APPLY` com a direção do lançamento (REFUND/WIN → CREDIT; BET → DEBIT; ROLLBACK → inverso da
 * referência; LOSS sem direção).
 *
 * Não conhece o saldo: "reversão deixaria saldo negativo" é decidido no use case, com o código de
 * `insufficientFundsCodeFor`.
 */
export class ReversalPolicy {
  static evaluate(
    operation: WagerTransaction,
    reference: WagerTransaction | undefined,
    context: ReversalContext = {},
  ): ReversalDecision {
    const allowedKinds = ALLOWED_REFERENCE_KINDS[operation.kind];
    if (allowedKinds === undefined || operation.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError(
        'INVALID_WAGER_OPERATION',
        `ReversalPolicy only evaluates a non-OPENING transaction with a reference (got ${operation.kind})`,
      );
    }
    if (reference !== undefined && reference.externalTransactionId !== operation.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(
        'INVALID_WAGER_OPERATION',
        'ReversalPolicy received a transaction that is not the referenced one',
      );
    }
    if (
      reference === undefined ||
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return PENDING;
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.REFERENCE_NOT_PROCESSED);
    }
    if (!allowedKinds.includes(reference.kind)) {
      return reject(FailureCode.REFERENCE_KIND_NOT_ALLOWED);
    }
    if (!ReversalPolicy.sameScope(operation, reference)) {
      return reject(FailureCode.REFERENCE_MISMATCH);
    }
    if (ReversalPolicy.isReversal(operation.kind) && !operation.money.equals(reference.money)) {
      return reject(FailureCode.REFERENCE_AMOUNT_MISMATCH);
    }
    if (context.alreadyReversed === true) {
      return reject(FailureCode.ALREADY_REVERSED);
    }
    if (!operation.affectsBalance()) {
      return Object.freeze({ outcome: 'APPLY' });
    }
    return Object.freeze({ outcome: 'APPLY', direction: operation.ledgerDirectionFor(reference) });
  }

  /**
   * Código de rejeição quando o débito não cabe no saldo: reversões (na prática ROLLBACK de WIN/REFUND)
   * usam `REVERSAL_INSUFFICIENT_FUNDS`, distinto de uma aposta sem saldo (`INSUFFICIENT_FUNDS`) — regra 7.9.
   */
  static insufficientFundsCodeFor(kind: WagerTransactionKind): FailureCode {
    return ReversalPolicy.isReversal(kind) ? FailureCode.REVERSAL_INSUFFICIENT_FUNDS : FailureCode.INSUFFICIENT_FUNDS;
  }

  private static isReversal(kind: WagerTransactionKind): boolean {
    return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  }

  /** Mesmo provider, player, wallet, moeda e rodada (regra 7.2). */
  private static sameScope(operation: WagerTransaction, reference: WagerTransaction): boolean {
    return (
      operation.providerId === reference.providerId &&
      operation.playerId === reference.playerId &&
      operation.walletId === reference.walletId &&
      operation.money.currency === reference.money.currency &&
      operation.roundId === reference.roundId
    );
  }
}
