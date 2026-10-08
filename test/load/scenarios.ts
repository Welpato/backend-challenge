import type { OperationSource, Outcome } from './driver';
import type { Channel, LoadWallet, Operation, OperationFactory, TransactionInput } from './operations';

/**
 * Os quatro cenários da F16. Cada um define as wallets que abre, a concorrência e a fonte de operações; o
 * `run.ts` cuida de aquecimento, janela medida, coleta e verificação.
 */
export interface ScenarioDefinition {
  readonly id: number;
  readonly name: string;
  readonly title: string;
  readonly concurrency: number;
  readonly walletCount: number;
  readonly initialAmount: string;
  readonly usesQueue: boolean;
  createSource(wallets: readonly LoadWallet[], factory: OperationFactory, random: () => number): OperationSource;
}

/** BETs confirmadas (201) que ainda podem ser estornadas — cada uma sai do pool ao virar REFUND. */
class RefundPool {
  private readonly bets: TransactionInput[] = [];

  add(bet: TransactionInput): void {
    if (this.bets.length >= 5000) {
      this.bets.shift();
    }
    this.bets.push(bet);
  }

  take(random: () => number): TransactionInput | undefined {
    if (this.bets.length === 0) {
      return undefined;
    }
    const index = Math.floor(random() * this.bets.length);
    const [bet] = this.bets.splice(index, 1);
    return bet;
  }
}

/** Mix BET 50% · WIN 25% · LOSS 15% · REFUND 10% (REFUND só de BET já confirmada por HTTP). */
function mixedOperation(
  wallets: readonly LoadWallet[],
  factory: OperationFactory,
  random: () => number,
  pool: RefundPool,
  channel: Channel,
): Operation {
  const roll = random();
  if (roll < 0.1 && channel === 'http') {
    const bet = pool.take(random);
    if (bet !== undefined) {
      return factory.refund(bet, channel);
    }
  }
  const wallet = factory.pick(wallets);
  if (roll < 0.6) {
    return factory.create(wallet, 'BET', channel);
  }
  if (roll < 0.85) {
    return factory.create(wallet, 'WIN', channel);
  }
  return factory.create(wallet, 'LOSS', channel);
}

function collectConfirmedBets(pool: RefundPool): (operation: Operation, outcome: Outcome) => void {
  return (operation, outcome) => {
    if (operation.input.kind === 'BET' && outcome.status === 201) {
      pool.add(operation.input);
    }
  };
}

export const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    id: 1,
    name: 'hot-wallet',
    title: 'Hot wallet: 1 wallet, concorrência 50, BET/WIN',
    concurrency: 50,
    walletCount: 1,
    // Saldo alto: o cenário mede serialização, não rejeição por saldo.
    initialAmount: '1000000.00',
    usesQueue: false,
    createSource(wallets, factory, random) {
      return {
        next: () => factory.create(factory.pick(wallets), random() < 0.5 ? 'BET' : 'WIN', 'http'),
      };
    },
  },
  {
    id: 2,
    name: 'spread-wallets',
    title: 'Wallets espalhadas: 1.000 wallets, concorrência 100, BET/WIN/LOSS/REFUND',
    concurrency: 100,
    walletCount: 1000,
    initialAmount: '1000.00',
    usesQueue: false,
    createSource(wallets, factory, random) {
      const pool = new RefundPool();
      return {
        next: () => mixedOperation(wallets, factory, random, pool, 'http'),
        onOutcome: collectConfirmedBets(pool),
      };
    },
  },
  {
    id: 3,
    name: 'duplicate-storm',
    title: 'Tempestade de duplicatas: 200 wallets, concorrência 100, 30% reenvios',
    concurrency: 100,
    walletCount: 200,
    initialAmount: '1000.00',
    usesQueue: false,
    createSource(wallets, factory, random) {
      // Janela das últimas operações enviadas: boa parte dos reenvios chega com o original ainda em voo
      // (duplicata concorrente, que espera no índice único), o resto depois do commit (replay simples).
      const recent: Operation[] = [];
      return {
        next: () => {
          if (recent.length > 0 && random() < 0.3) {
            return { ...factory.pick(recent), duplicate: true };
          }
          const operation = factory.create(factory.pick(wallets), random() < 0.6 ? 'BET' : 'WIN', 'http');
          recent.push(operation);
          if (recent.length > 500) {
            recent.shift();
          }
          return operation;
        },
      };
    },
  },
  {
    id: 4,
    name: 'http-and-queue',
    title: 'HTTP + fila: 500 wallets, concorrência 100, metade via SQS',
    concurrency: 100,
    walletCount: 500,
    initialAmount: '1000.00',
    usesQueue: true,
    createSource(wallets, factory, random) {
      const pool = new RefundPool();
      return {
        mixedChannels: true,
        next: (channel: Channel) => mixedOperation(wallets, factory, random, pool, channel),
        onOutcome: collectConfirmedBets(pool),
      };
    },
  },
];
