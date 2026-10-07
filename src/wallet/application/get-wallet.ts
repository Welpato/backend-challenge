import type { UnitOfWork } from '@/shared/persistence/unit-of-work';
import type { WalletRepository } from '@/wallet/application/wallet.repository.port';
import type { Wallet } from '@/wallet/domain/wallet';
import { WalletNotFoundError } from '@/wallet/domain/wallet.errors';

/** Consulta da wallet (sem lock). Inexistente → `WalletNotFoundError` (404). */
export class GetWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
  ) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.run(() => this.wallets.findById(walletId));
    if (wallet === undefined) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }
}
