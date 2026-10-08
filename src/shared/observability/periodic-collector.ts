import { type BeforeApplicationShutdown, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { PollingLoop } from '@/shared/workers/polling-loop';

/**
 * Coleta periódica e leve de gauges que dependem do banco (`outbox_pending`, `outbox_lag_seconds`,
 * `pending_references`…): uma consulta a cada `intervalMs` (`METRICS_COLLECT_INTERVAL_MS`, 5 s), **nunca** no
 * scrape do `/metrics` — o Prometheus de várias réplicas não vira carga no PostgreSQL. Falha só é logada (o gauge
 * fica com o último valor). Para no shutdown, antes de o ORM fechar.
 */
export class PeriodicCollector implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger: Logger;
  private readonly loop: PollingLoop;

  constructor(
    name: string,
    intervalMs: number,
    private readonly collect: () => Promise<void>,
  ) {
    this.logger = new Logger(name);
    this.loop = new PollingLoop(
      async () => {
        await this.collect();
        return 'idle';
      },
      { intervalMs, onError: (error) => this.logger.warn({ err: error }, 'Metrics collection failed') },
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /** Coleta já (testes e a primeira leitura). */
  collectNow(): Promise<void> {
    return this.collect();
  }
}
