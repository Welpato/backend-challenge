import { DomainError } from '@/shared/errors/domain-error';
import type { FailureCode } from '@/shared/failure-code';
import type { WagerTransactionStatus } from '@/wagering/domain/transaction-status';

/**
 * Transição de status não permitida pela tabela (ex.: sair de um estado terminal). Erro de
 * programação: o use case nunca deve tentar — não é caminho de negócio nem chega ao provedor.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly from: WagerTransactionStatus;
  readonly to: WagerTransactionStatus;

  constructor(from: WagerTransactionStatus, to: WagerTransactionStatus, detail?: string) {
    super(
      'INVALID_TRANSACTION_STATE',
      `Invalid transaction state transition: ${from} -> ${to}${detail ? ` (${detail})` : ''}`,
    );
    this.from = from;
    this.to = to;
  }
}

/**
 * Transação de aposta inválida.
 *
 * - Na criação a partir de entrada externa, `code` é um `FailureCode` de contrato
 *   (`VALIDATION_ERROR` ou `KIND_NOT_ALLOWED` para `OPENING`) — vira 400 / DLQ.
 * - Uso incorreto da API do domínio (ex.: `ledgerDirectionFor` em LOSS, código de falha
 *   incompatível com o status) usa `INVALID_WAGER_OPERATION`: erro de programação.
 */
export class InvalidWagerTransactionError extends DomainError {
  constructor(code: FailureCode | 'INVALID_WAGER_OPERATION', message: string) {
    super(code, message);
  }
}
