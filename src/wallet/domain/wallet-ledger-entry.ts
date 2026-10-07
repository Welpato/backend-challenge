import type { Money } from '@/shared/money/money';
import { LedgerDirection } from '@/wallet/domain/ledger-direction';
import { InvalidLedgerEntryError } from '@/wallet/domain/wallet.errors';

/** Estado completo de um lançamento (criação e reidratação usam o mesmo formato). */
export interface LedgerEntryState {
  id: string;
  walletId: string;
  /** Transação de negócio (`wager_transactions.id`) que originou o lançamento. */
  transactionId: string;
  direction: LedgerDirection;
  /** Valor movimentado, sempre positivo. */
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /**
   * Versão da wallet **depois** deste lançamento. É um contador (não dinheiro), por isso `number`.
   * Lançamentos de uma wallet têm versões contíguas a partir de 1.
   */
  walletVersion: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Lançamento imutável do ledger da wallet (append-only).
 *
 * Não tem campos mutáveis nem métodos de transição: a instância é congelada e as datas são cópias.
 * `create` garante `money > 0`, mesma moeda nos três valores, `balanceAfter >= 0` e
 * `balanceBefore ± money === balanceAfter`; `rehydrate` só reconstrói o que já foi persistido.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    WalletLedgerEntry.assertValid(props);
    return WalletLedgerEntry.build(props);
  }

  /** Reconstrução a partir da persistência — não revalida regras. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** `balanceBefore ± money === balanceAfter`. Sempre verdadeiro para lançamentos criados por `create`. */
  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.balanceAfter.currency !== this.balanceBefore.currency
    ) {
      return false;
    }
    return WalletLedgerEntry.expectedAfter(this.direction, this.balanceBefore, this.money).equals(this.balanceAfter);
  }

  private static build(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      new Date(state.createdAt.getTime()),
    );
  }

  private static expectedAfter(direction: LedgerDirection, before: Money, money: Money): Money {
    return direction === LedgerDirection.Debit ? before.subtract(money) : before.add(money);
  }

  private static assertValid(props: CreateLedgerEntryProps): void {
    for (const field of ['id', 'walletId', 'transactionId'] as const) {
      if (typeof props[field] !== 'string' || props[field].length === 0) {
        throw new InvalidLedgerEntryError(`Invalid ledger entry: ${field} is required`);
      }
    }
    if (props.direction !== LedgerDirection.Debit && props.direction !== LedgerDirection.Credit) {
      throw new InvalidLedgerEntryError('Invalid ledger entry: unknown direction');
    }
    if (!Number.isSafeInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError('Invalid ledger entry: walletVersion must be a positive integer');
    }
    if (!(props.createdAt instanceof Date) || Number.isNaN(props.createdAt.getTime())) {
      throw new InvalidLedgerEntryError('Invalid ledger entry: createdAt must be a valid date');
    }
    const { money, balanceBefore, balanceAfter } = props;
    if (money.currency !== balanceBefore.currency || balanceAfter.currency !== balanceBefore.currency) {
      throw new InvalidLedgerEntryError('Invalid ledger entry: money and balances must share the same currency');
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError('Invalid ledger entry: money must be positive');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Invalid ledger entry: balances must not be negative');
    }
    if (!WalletLedgerEntry.expectedAfter(props.direction, balanceBefore, money).equals(balanceAfter)) {
      throw new InvalidLedgerEntryError('Invalid ledger entry: balanceBefore and money do not add up to balanceAfter');
    }
  }
}
