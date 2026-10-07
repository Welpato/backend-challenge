import type { UnitOfWork } from '@/shared/persistence/unit-of-work';
import type { LedgerRepository } from '@/wallet/application/ledger.repository.port';
import { encodeLedgerCursor } from '@/wallet/application/ledger-cursor';
import type { WalletRepository } from '@/wallet/application/wallet.repository.port';
import { WalletNotFoundError } from '@/wallet/domain/wallet.errors';
import type { WalletLedgerEntry } from '@/wallet/domain/wallet-ledger-entry';

export const LEDGER_PAGE_DEFAULT_LIMIT = 50;
export const LEDGER_PAGE_MAX_LIMIT = 200;

export interface GetLedgerQuery {
  readonly walletId: string;
  /** Última `walletVersion` já entregue (cursor decodificado); `0` = desde o início. */
  readonly afterVersion: number;
  readonly limit: number;
}

export interface LedgerPage {
  readonly items: readonly WalletLedgerEntry[];
  /** Cursor da próxima página; `null` quando esta é a última. */
  readonly nextCursor: string | null;
}

/**
 * Página do ledger em ordem crescente de `wallet_version` (keyset). Lê `limit + 1` linhas para saber se existe
 * próxima página sem devolver uma página final vazia. Wallet inexistente → 404.
 */
export class GetLedger {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
  ) {}

  async execute(query: GetLedgerQuery): Promise<LedgerPage> {
    const { walletId, afterVersion, limit } = query;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LEDGER_PAGE_MAX_LIMIT) {
      throw new RangeError(`limit must be an integer between 1 and ${LEDGER_PAGE_MAX_LIMIT}`);
    }
    const rows = await this.uow.run(async () => {
      if ((await this.wallets.findById(walletId)) === undefined) {
        throw new WalletNotFoundError(walletId);
      }
      return this.ledger.page(walletId, afterVersion, limit + 1);
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = rows.length > limit && last !== undefined ? encodeLedgerCursor(last.walletVersion) : null;
    return { items, nextCursor };
  }
}
