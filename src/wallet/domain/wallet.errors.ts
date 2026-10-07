import { DomainError } from '@/shared/errors/domain-error';
import { FailureCode } from '@/shared/failure-code';

/** Débito maior que o saldo disponível. Falha de negócio: a transação é gravada como `REJECTED`. */
export class InsufficientFundsError extends DomainError {
  constructor() {
    super(FailureCode.INSUFFICIENT_FUNDS, 'Insufficient funds');
  }
}

/**
 * Lançamento de ledger com aritmética ou dados inconsistentes. Erro de programação: nunca deve
 * acontecer pelo caminho da `Wallet`, que só produz lançamentos válidos.
 */
export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super('INVALID_LEDGER_ENTRY', message);
  }
}

/** Operação inválida sobre a wallet (ex.: valor não positivo, abertura com saldo sem transação). Erro de programação. */
export class InvalidWalletOperationError extends DomainError {
  constructor(message: string) {
    super('INVALID_WALLET_OPERATION', message);
  }
}
