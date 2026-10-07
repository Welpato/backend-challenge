import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@/config/app-config';
import { HEALTH_INDICATORS, type HealthIndicator } from './health-indicator';

export type CheckResult =
  | { readonly status: 'up'; readonly latencyMs: number }
  | { readonly status: 'down'; readonly latencyMs: number; readonly error: string };

export interface ReadinessReport {
  readonly status: 'ok' | 'unavailable';
  readonly shuttingDown: boolean;
  readonly checks: Readonly<Record<string, CheckResult>>;
}

async function runCheck(indicator: HealthIndicator, timeoutMs: number): Promise<CheckResult> {
  const controller = new AbortController();
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([indicator.check(controller.signal), timeout]);
    return { status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message || error.name : String(error);
    return { status: 'down', latencyMs: Math.round(performance.now() - startedAt), error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Readiness = todas as dependências alcançáveis **e** o processo fora de shutdown.
 * O flag de shutdown é ligado no primeiro hook do encerramento (`onModuleDestroy`), para que
 * o balanceador veja 503 enquanto o servidor HTTP ainda drena as requisições em andamento.
 */
@Injectable()
export class ReadinessService implements OnModuleDestroy {
  private shuttingDown = false;

  constructor(
    @Inject(HEALTH_INDICATORS) private readonly indicators: readonly HealthIndicator[],
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleDestroy(): void {
    this.shuttingDown = true;
  }

  async check(): Promise<ReadinessReport> {
    const timeoutMs = this.config.timeouts.healthCheckMs;
    const results = await Promise.all(
      this.indicators.map(async (indicator) => [indicator.name, await runCheck(indicator, timeoutMs)] as const),
    );
    const checks = Object.fromEntries(results);
    const allUp = results.every(([, result]) => result.status === 'up');
    return {
      status: allUp && !this.shuttingDown ? 'ok' : 'unavailable',
      shuttingDown: this.shuttingDown,
      checks,
    };
  }
}
