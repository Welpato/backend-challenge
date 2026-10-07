import type { EntityDictionary } from '@mikro-orm/core';
import { ConcurrencyInvariantError } from '@/shared/persistence/persistence.errors';
import { UNTRACKED } from '@/shared/persistence/read-options';
import { fromSafeInteger } from '@/shared/persistence/record-conversion';
import type { UnitOfWork } from '@/shared/persistence/unit-of-work';
import type { WalletRepository } from '@/wallet/application/wallet.repository.port';
import type { Wallet } from '@/wallet/domain/wallet';
import { WalletMapper } from '@/wallet/infrastructure/wallet.mapper';
import { WalletRecord } from '@/wallet/infrastructure/wallet.record';

/** `WalletRepository` sobre o MikroORM. Usa o `EntityManager` da `UnitOfWork` corrente. */
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.uow.em.insert(WalletRecord, WalletMapper.toRecord(wallet));
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.uow.em.findOne(WalletRecord, { id }, UNTRACKED);
    return record === null ? undefined : WalletMapper.toDomain(record);
  }

  /**
   * Lock pessimista de escrita da wallet com `SELECT … FOR NO KEY UPDATE` (não `FOR UPDATE`, que é o que
   * `LockMode.PESSIMISTIC_WRITE` gera). Motivo: a ordem de locks (§2) insere a transação **antes** de travar
   * a wallet, e o INSERT em `wager_transactions`/`wallet_ledger_entries` checa a FK `wallet_id` com
   * `FOR KEY SHARE` na wallet. `FOR UPDATE` conflita com `FOR KEY SHARE`: duas operações concorrentes na
   * mesma wallet (cada uma com o KEY SHARE do próprio INSERT) entravam em deadlock (`40P01`, reproduzido no
   * teste). `FOR NO KEY UPDATE` é o mesmo lock que o próprio `UPDATE wallets SET balance…` toma (nenhuma
   * coluna de chave muda): continua exclusivo entre escritores — serializa débitos/créditos da wallet — e é
   * compatível com as checagens de FK. O MikroORM não tem `LockMode` para ele, por isso a query é explícita;
   * `em.map(…, UNTRACKED)` aplica os tipos das colunas sem passar pelo Identity Map.
   */
  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const em = this.uow.em;
    const [row] = await em.execute<EntityDictionary<WalletRecord>[]>(
      'select * from wallets where id = ? for no key update',
      [id],
    );
    return row === undefined ? undefined : WalletMapper.toDomain(em.map(WalletRecord, row, UNTRACKED));
  }

  async updateBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const { balance, version, updatedAt } = WalletMapper.toRecord(wallet);
    const affected = await this.uow.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: fromSafeInteger(expectedVersion, 'expectedVersion') },
      { balance, version, updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyInvariantError(
        `Wallet ${wallet.id} was not at version ${expectedVersion} when updating its balance`,
      );
    }
  }
}
