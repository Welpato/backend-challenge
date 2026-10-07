import type { EventContext } from '@/shared/events/event-context';
import { IntegrationEvent, type IntegrationEventProps } from '@/shared/events/integration-event';
import { InvalidIntegrationEventError } from '@/shared/events/integration-event.errors';
import type { MoneyProps } from '@/shared/money/money-props';
import type { LedgerDirection } from '@/wallet/domain/ledger-direction';
import type { Wallet } from '@/wallet/domain/wallet';
import type { WalletLedgerEntry } from '@/wallet/domain/wallet-ledger-entry';

/** Campos exatamente como no enunciado (DESAFIO.md §11). */
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/**
 * Emitido **somente** quando o saldo muda — um evento por lançamento no ledger. `aggregateId` é a
 * wallet. O lançamento precisa ser o que acabou de ser aplicado à wallet: mesma wallet e
 * `walletVersion` igual à versão atual (senão o evento descreveria um estado que não é o dela).
 */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidIntegrationEventError('WalletBalanceChanged: the ledger entry belongs to another wallet');
    }
    if (entry.walletVersion !== wallet.version) {
      throw new InvalidIntegrationEventError(
        'WalletBalanceChanged: the ledger entry is not the latest change of the wallet',
      );
    }
    const data: WalletBalanceChangedData = {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: entry.walletVersion,
    };
    return IntegrationEvent.seal(new WalletBalanceChanged(IntegrationEvent.propsFrom(wallet.id, data, ctx)));
  }
}
