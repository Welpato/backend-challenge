import { describe, expect, it } from 'bun:test';
import { loadConfig } from '@/config/load-config';
import type { HealthIndicator } from '@/health/health-indicator';
import { ReadinessService } from '@/health/readiness.service';

// Unidade da agregação de readiness. Os indicadores reais (PG/SQS) são exercitados nos testes de integração.
const config = loadConfig({
  DATABASE_URL: 'postgresql://app:app@localhost:5432/wagering',
  HEALTH_CHECK_TIMEOUT_MS: '100',
});

function indicator(name: string, check: (signal: AbortSignal) => Promise<void>): HealthIndicator {
  return { name, check };
}

const up = (name: string) => indicator(name, async () => {});

describe('ReadinessService', () => {
  it('is ok when every dependency is up', async () => {
    const report = await new ReadinessService([up('postgres'), up('sqs')], config).check();

    expect(report.status).toBe('ok');
    expect(report.shuttingDown).toBe(false);
    expect(report.checks.postgres?.status).toBe('up');
    expect(report.checks.sqs?.status).toBe('up');
  });

  it('is unavailable when a dependency fails, with the error message', async () => {
    const failing = indicator('sqs', async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const report = await new ReadinessService([up('postgres'), failing], config).check();

    expect(report.status).toBe('unavailable');
    expect(report.checks.postgres?.status).toBe('up');
    expect(report.checks.sqs).toMatchObject({ status: 'down', error: 'connect ECONNREFUSED' });
  });

  it('times out a hanging dependency and aborts its signal', async () => {
    let aborted = false;
    const hanging = indicator('postgres', (signal) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise<void>(() => {});
    });

    const startedAt = performance.now();
    const report = await new ReadinessService([hanging], config).check();

    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(report.status).toBe('unavailable');
    expect(report.checks.postgres).toMatchObject({ status: 'down', error: 'timed out after 100ms' });
    expect(aborted).toBe(true);
  });

  it('reports unavailable once shutdown has started', async () => {
    const service = new ReadinessService([up('postgres'), up('sqs')], config);
    service.onModuleDestroy();

    const report = await service.check();
    expect(report.status).toBe('unavailable');
    expect(report.shuttingDown).toBe(true);
  });
});
