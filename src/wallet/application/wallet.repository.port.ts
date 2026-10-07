import type { Wallet } from '@/wallet/domain/wallet';

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');

/**
 * Porta de persistência da wallet. Todas as operações rodam dentro de uma `UnitOfWork`.
 *
 * Toda mudança de saldo segue: `findByIdForUpdate` (lock da linha) → `wallet.debit|credit` →
 * `updateBalance(wallet, versãoLida)` → `LedgerRepository.append(lançamento)`, na mesma transação.
 */
export interface WalletRepository {
  /** INSERT da wallet recém-aberta. `(player_id, currency)` duplicado → `UniqueViolationError` (`uq_wallets_player_currency`). */
  insert(wallet: Wallet): Promise<void>;
  /** Leitura sem lock (consultas). */
  findById(id: string): Promise<Wallet | undefined>;
  /**
   * `SELECT … FOR UPDATE` da wallet: bloqueia até quem tem o lock commitar/abortar, ou falha com
   * `TransientDatabaseError('lock_timeout')` após o `lock_timeout` da transação. Sempre relê do banco.
   */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  /**
   * `UPDATE wallets SET balance, version, updated_at WHERE id = :id AND version = :expectedVersion`.
   * 0 linhas → `ConcurrencyInvariantError` (guarda extra além do lock; indica bug).
   */
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}
