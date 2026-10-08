/**
 * Operações geradas pelo teste de carga. Valores monetários são **strings** escolhidas de uma lista fixa — o
 * teste nunca faz conta com dinheiro (quem soma e confere é o PostgreSQL, em `NUMERIC`).
 */
export const AMOUNTS = ['1.00', '2.50', '5.00', '10.00', '20.00'] as const;
export const PROVIDER_ID = 'load-provider';
export const CURRENCY = 'BRL';

export type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND';
export type Channel = 'http' | 'sqs';

export interface TransactionInput {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: Kind;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId?: string;
}

export interface Operation {
  readonly channel: Channel;
  readonly key: string;
  readonly input: TransactionInput;
  /** Reenvio de uma operação já enviada (mesma key e mesmo payload) — cenário 3. */
  readonly duplicate: boolean;
}

export interface LoadWallet {
  readonly walletId: string;
  readonly playerId: string;
}

/** Fábrica de operações de um cenário: ids únicos por execução (`runId`) e por cenário. */
export class OperationFactory {
  private sequence = 0;

  constructor(
    private readonly prefix: string,
    private readonly random: () => number,
  ) {}

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.random() * items.length)];
    if (item === undefined) {
      throw new Error('cannot pick from an empty list');
    }
    return item;
  }

  amount(): string {
    return this.pick(AMOUNTS);
  }

  /** Nova operação sem referência (BET/WIN/LOSS), cada uma numa rodada própria. */
  create(wallet: LoadWallet, kind: Exclude<Kind, 'REFUND'>, channel: Channel, amount = this.amount()): Operation {
    this.sequence += 1;
    const id = `${this.prefix}-${this.sequence}`;
    return {
      channel,
      key: id,
      duplicate: false,
      input: {
        providerId: PROVIDER_ID,
        externalTransactionId: id,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: `round-${id}`,
        gameId: 'load-game',
        kind,
        money: { amount, currency: CURRENCY },
      },
    };
  }

  /** REFUND de uma BET já confirmada: mesma wallet, rodada e valor (regra 7.2). */
  refund(bet: TransactionInput, channel: Channel): Operation {
    this.sequence += 1;
    const id = `${this.prefix}-${this.sequence}`;
    return {
      channel,
      key: id,
      duplicate: false,
      input: {
        ...bet,
        externalTransactionId: id,
        kind: 'REFUND',
        referenceExternalTransactionId: bet.externalTransactionId,
      },
    };
  }
}

/** `POST /wallets` com saldo inicial; abre `count` wallets com concorrência limitada. */
export async function openWallets(
  baseUrls: readonly string[],
  prefix: string,
  count: number,
  initialAmount: string,
): Promise<LoadWallet[]> {
  const wallets: LoadWallet[] = new Array(count);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) {
      const index = next;
      next += 1;
      const playerId = `${prefix}-player-${index}`;
      const url = baseUrls[index % baseUrls.length] as string;
      const response = await fetch(`${url}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, initialBalance: { amount: initialAmount, currency: CURRENCY } }),
      });
      if (response.status !== 201) {
        throw new Error(`POST /wallets → ${response.status}: ${await response.text()}`);
      }
      const body = (await response.json()) as { id: string };
      wallets[index] = { walletId: body.id, playerId };
    }
  };
  await Promise.all(Array.from({ length: Math.min(25, count) }, worker));
  return wallets;
}

/** Envelope `WagerTransactionRequested` (F12) de uma operação. */
export function envelopeOf(operation: Operation, messageId: string): string {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...operation.input, idempotencyKey: operation.key },
  });
}
