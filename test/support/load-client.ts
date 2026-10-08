import { seededRandom } from './seeded-random';
import { type HttpResult, type SubmitBody, submit, type TransactionInput } from './wagering-http';

/** Resultado de uma submissão distribuída: a resposta (ou `status: 0` se a conexão falhou) e a instância usada. */
export interface DistributedResult extends HttpResult<SubmitBody> {
  readonly url: string;
}

/**
 * Cliente de carga dos testes multi-instância (F13). Distribui requisições entre as APIs — metade em
 * round-robin, metade sorteada por um PRNG com seed fixa (reprodutível) — e oferece uma **barreira**: todas as
 * requisições são montadas antes e só disparam juntas, para maximizar a simultaneidade real entre processos.
 */
export class LoadClient {
  private readonly random: () => number;
  private next = 0;

  constructor(
    private readonly urls: readonly string[],
    seed: number,
  ) {
    if (urls.length === 0) {
      throw new Error('LoadClient needs at least one URL');
    }
    this.random = seededRandom(seed);
  }

  /** Próxima instância: alterna round-robin e sorteio. */
  pick(): string {
    this.next += 1;
    const index = this.next % 2 === 0 ? this.next % this.urls.length : Math.floor(this.random() * this.urls.length);
    return this.urls[index] as string;
  }

  /** Instância `n` (mod N) — para mandar operações relacionadas a instâncias diferentes de propósito. */
  at(n: number): string {
    return this.urls[n % this.urls.length] as string;
  }

  /** `POST /wagering/transactions` numa instância; falha de conexão vira `status: 0` (o chamador decide reenviar). */
  async submitTo(url: string, input: TransactionInput, key?: string): Promise<DistributedResult> {
    try {
      return { ...(await submit(url, input, key)), url };
    } catch {
      return { status: 0, headers: new Headers(), body: undefined as unknown as SubmitBody, url };
    }
  }

  /** Todas as operações, distribuídas entre as instâncias, disparadas juntas (barreira). */
  async submitAll(inputs: readonly TransactionInput[]): Promise<DistributedResult[]> {
    const targets = inputs.map(() => this.pick());
    return simultaneously(inputs.map((input, index) => () => this.submitTo(targets[index] as string, input)));
  }
}

/** Barreira de largada: as tarefas são criadas antes e começam todas no mesmo tick. */
export async function simultaneously<T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
  const gate = Promise.withResolvers<void>();
  const running = tasks.map(async (task) => {
    await gate.promise;
    return task();
  });
  gate.resolve();
  return Promise.all(running);
}
