import type { UnitOfWork } from '@/shared/persistence/unit-of-work';
import type { WagerTransactionRepository } from '@/wagering/application/wager-transaction.repository.port';
import type { WagerTransaction } from '@/wagering/domain/wager-transaction';

/** Consultas de transação (DESAFIO.md §9). Sem lock: só leitura do estado commitado. `undefined` = inexistente. */
export class GetWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly transactions: WagerTransactionRepository,
  ) {}

  byId(id: string): Promise<WagerTransaction | undefined> {
    return this.uow.run(() => this.transactions.findById(id), { readOnly: true });
  }

  byProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.uow.run(() => this.transactions.findByProviderExternalId(providerId, externalTransactionId), {
      readOnly: true,
    });
  }
}
