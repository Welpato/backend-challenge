/**
 * Resultado de uma iteração: `busy` = encheu o lote, roda de novo imediatamente; `idle` = espera o intervalo.
 */
export type IterationResult = 'busy' | 'idle';

export interface PollingLoopOptions {
  /** Espera entre iterações quando a anterior não encheu o lote. */
  readonly intervalMs: number;
  /** Chamado quando a iteração lança; o loop continua depois do intervalo. */
  readonly onError: (error: unknown) => void;
}

/**
 * Loop de polling dos workers (reprocessador, publisher da outbox). Uma iteração por vez, nunca em paralelo
 * consigo mesma; adaptativo (sem espera quando a iteração diz que há mais trabalho).
 *
 * `stop()` não interrompe uma iteração em andamento: corta só a espera e resolve quando a iteração atual
 * termina — "termina o lote atual e para". Depois disso o chamador pode fechar o ORM com segurança.
 */
export class PollingLoop {
  private running = false;
  private current: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly iteration: () => Promise<IterationResult>,
    private readonly options: PollingLoopOptions,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.current = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.current;
    this.current = undefined;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let result: IterationResult = 'idle';
      try {
        result = await this.iteration();
      } catch (error: unknown) {
        this.options.onError(error);
      }
      if (this.running && result === 'idle') {
        await this.sleep(this.options.intervalMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
