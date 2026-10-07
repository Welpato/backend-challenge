import { DomainError } from '@/shared/errors/domain-error';
import { FailureCode } from '@/shared/failure-code';

/** Valor ou moeda fora do contrato. A mensagem nunca ecoa o valor recebido (logs não carregam dinheiro). */
export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(FailureCode.VALIDATION_ERROR, message);
  }
}

/** Operação entre valores de moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(FailureCode.CURRENCY_MISMATCH, `Currency mismatch: expected ${expected}, got ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}
