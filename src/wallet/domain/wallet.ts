import { newUuidV7 } from '@/shared/ids';
import { Money } from '@/shared/money/money';
import { CurrencyMismatchError } from '@/shared/money/money.errors';
import { LedgerDirection } from '@/wallet/domain/ledger-direction';
import { InsufficientFundsError, InvalidWalletOperationError } from '@/wallet/domain/wallet.errors';
import { WalletLedgerEntry } from '@/wallet/domain/wallet-ledger-entry';

/** Estado persistido da wallet. A moeda da wallet é a moeda de `balance`. */
export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  /** Contador de alterações de saldo (não é dinheiro, por isso `number`). */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  /** Saldo de abertura (≥ 0). A moeda dele define a moeda da wallet. */
  initialBalance: Money;
  /** Obrigatório quando `initialBalance > 0`: transação `OPENING` que origina o crédito de abertura. */
  openingTransactionId?: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Lançamento CREDIT `0 → initialBalance` com `walletVersion = 1`; ausente quando o saldo inicial é zero. */
  openingEntry?: WalletLedgerEntry;
}

/**
 * Aggregate root da carteira de um jogador em uma moeda.
 *
 * `debit`/`credit` são a **única** forma de alterar o saldo e cada chamada devolve o lançamento de
 * ledger correspondente, já com `balanceBefore`, `balanceAfter` e `walletVersion` — saldo e ledger
 * não têm como divergir no domínio. Uma operação que lança erro não altera nenhum estado.
 *
 * `version` é um contador (`number`, não dinheiro): começa em 1 na abertura (com ou sem crédito de
 * abertura) e incrementa a cada alteração de saldo. Como débito/crédito exigem valor positivo, toda
 * operação bem-sucedida altera o saldo e incrementa a versão exatamente uma vez.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet com `version = 1`. O crédito de abertura faz parte da criação: com saldo inicial
   * positivo, o lançamento CREDIT `0 → initialBalance` sai com `walletVersion = 1` (o mesmo número da
   * wallet) e exige `openingTransactionId`. Com saldo zero não há lançamento e `openingTransactionId`
   * é ignorado.
   */
  static open(props: OpenWalletProps): OpenedWallet {
    const { id, playerId, initialBalance, openingTransactionId, at } = props;
    if (id.length === 0 || playerId.length === 0) {
      throw new InvalidWalletOperationError('Cannot open wallet: id and playerId are required');
    }
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError('Cannot open wallet: initial balance must not be negative');
    }
    Wallet.assertValidDate(at);
    const zero = Money.zero(initialBalance.currency);
    const wallet = new Wallet(
      id,
      playerId,
      initialBalance.currency,
      initialBalance,
      1,
      Wallet.copy(at),
      Wallet.copy(at),
    );
    if (initialBalance.isZero()) {
      return { wallet };
    }
    if (openingTransactionId === undefined || openingTransactionId.length === 0) {
      throw new InvalidWalletOperationError(
        'Cannot open wallet: a positive initial balance requires an opening transaction',
      );
    }
    const openingEntry = WalletLedgerEntry.create({
      id: newUuidV7(),
      walletId: id,
      transactionId: openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: zero,
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.balance.currency,
      state.balance,
      state.version,
      Wallet.copy(state.createdAt),
      Wallet.copy(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return Wallet.copy(this._createdAt);
  }

  get updatedAt(): Date {
    return Wallet.copy(this._updatedAt);
  }

  /** Debita `money` (> 0). Lança `InsufficientFundsError` se o saldo não cobre o valor; saldo zero é permitido. */
  debit(transactionId: string, money: Money, at: Date): WalletLedgerEntry {
    this.assertOperation(transactionId, money, at);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError();
    }
    return this.apply(LedgerDirection.Debit, transactionId, money, at);
  }

  /** Credita `money` (> 0). */
  credit(transactionId: string, money: Money, at: Date): WalletLedgerEntry {
    this.assertOperation(transactionId, money, at);
    return this.apply(LedgerDirection.Credit, transactionId, money, at);
  }

  /** Cria o lançamento primeiro (pode lançar) e só então muda o estado — falha não deixa estado parcial. */
  private apply(direction: LedgerDirection, transactionId: string, money: Money, at: Date): WalletLedgerEntry {
    const balanceAfter = direction === LedgerDirection.Debit ? this._balance.subtract(money) : this._balance.add(money);
    const entry = WalletLedgerEntry.create({
      id: newUuidV7(),
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: at,
    });
    this._balance = entry.balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = Wallet.copy(at);
    return entry;
  }

  private assertOperation(transactionId: string, money: Money, at: Date): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError('Wallet operation amount must be positive');
    }
    if (transactionId.length === 0) {
      throw new InvalidWalletOperationError('Wallet operation requires a transactionId');
    }
    Wallet.assertValidDate(at);
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }

  private static assertValidDate(at: Date): void {
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new InvalidWalletOperationError('Wallet operation requires a valid date');
    }
  }

  private static copy(date: Date): Date {
    return new Date(date.getTime());
  }
}
