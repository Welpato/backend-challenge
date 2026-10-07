import { CorruptRecordError } from '@/shared/persistence/persistence.errors';
import { UNTRACKED } from '@/shared/persistence/read-options';
import { assertPositiveInteger, fromSafeInteger, toSafeInteger } from '@/shared/persistence/record-conversion';
import type { UnitOfWork } from '@/shared/persistence/unit-of-work';
import type { LedgerRepository, LedgerTotals } from '@/wallet/application/ledger.repository.port';
import type { WalletLedgerEntry } from '@/wallet/domain/wallet-ledger-entry';
import { LedgerEntryMapper } from '@/wallet/infrastructure/ledger-entry.mapper';
import { LedgerEntryRecord } from '@/wallet/infrastructure/ledger-entry.record';

/** Tamanho padrão do lote do `chain` (keyset em `wallet_version`). */
const DEFAULT_CHAIN_BATCH_SIZE = 500;

interface TotalsRow {
  credits: string;
  debits: string;
  entries: string;
}

/**
 * `LedgerRepository` sobre o MikroORM. Só INSERT e SELECT — o role `app` nem tem UPDATE/DELETE
 * nessa tabela, e o trigger `trg_ledger_append_only` barra até o dono.
 */
export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly chainBatchSize: number = DEFAULT_CHAIN_BATCH_SIZE,
  ) {
    assertPositiveInteger(chainBatchSize, 'chainBatchSize');
  }

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.uow.em.insert(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }

  async page(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
    assertPositiveInteger(limit, 'limit');
    const records = await this.uow.em.find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: fromSafeInteger(afterVersion, 'afterVersion') } },
      { ...UNTRACKED, orderBy: { walletVersion: 'asc' }, limit },
    );
    return records.map((record) => LedgerEntryMapper.toDomain(record));
  }

  /**
   * Somas no próprio PostgreSQL (`numeric`, exato). `coalesce(…, 0.00)` mantém a escala 2 também sem
   * lançamentos; o resultado sai como texto — nunca passa por `number`.
   */
  async aggregate(walletId: string): Promise<LedgerTotals> {
    const row = await this.uow.em.execute<TotalsRow>(
      `select coalesce(sum(amount) filter (where direction = 'CREDIT'), 0.00)::text as credits,
              coalesce(sum(amount) filter (where direction = 'DEBIT'), 0.00)::text as debits,
              count(*)::text as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
      'get',
    );
    return {
      walletId,
      credits: row.credits,
      debits: row.debits,
      entries: toSafeInteger(row.entries, 'count(wallet_ledger_entries)'),
    };
  }

  /** O iterador lê sob demanda: precisa ser consumido dentro da mesma `UnitOfWork.run`. */
  async *chain(walletId: string): AsyncIterable<WalletLedgerEntry> {
    let afterVersion = 0;
    for (;;) {
      const batch = await this.page(walletId, afterVersion, this.chainBatchSize);
      for (const entry of batch) {
        yield entry;
      }
      const last = batch.at(-1);
      if (last === undefined || batch.length < this.chainBatchSize) {
        return;
      }
      if (last.walletVersion <= afterVersion) {
        throw new CorruptRecordError(`Ledger of wallet ${walletId} did not advance past version ${afterVersion}`);
      }
      afterVersion = last.walletVersion;
    }
  }
}
