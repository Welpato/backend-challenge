/**
 * Erros da camada de persistência que não vêm de um SQLSTATE (ver `pg-errors.ts` para esses).
 */

/**
 * Uma invariante que o lock da wallet deveria garantir não se confirmou no banco — por exemplo,
 * `UPDATE wallets … WHERE version = :expected` não encontrou a linha. Com o `SELECT … FOR UPDATE`
 * antes, isso só acontece por bug (alguém alterou a wallet sem o lock). A transação deve abortar.
 */
export class ConcurrencyInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyInvariantError';
  }
}

/** Um valor lido do banco não cabe no modelo de domínio (dado corrompido ou schema divergente). */
export class CorruptRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptRecordError';
  }
}

/** Repositório chamado fora de `UnitOfWork.run`, ou `run` aninhado. */
export class UnitOfWorkScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnitOfWorkScopeError';
  }
}
