import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type RunningTestApp, startTestApp } from '../../support/test-app';

// Health checks contra PostgreSQL e SQS reais da infra de teste (docker-compose.test.yml).
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLOSED_PORT_URL = 'http://127.0.0.1:9';

describe('health endpoints (real infrastructure)', () => {
  let running: RunningTestApp;

  beforeAll(async () => {
    running = await startTestApp({ APP_ROLE: 'api', INSTANCE_ID: 'it-api-1' });
  });

  afterAll(async () => {
    await running.close();
  });

  it('GET /health/ready returns 200 with postgres and sqs up', async () => {
    const response = await fetch(`${running.baseUrl}/health/ready`);
    const body = (await response.json()) as { status: string; checks: Record<string, { status: string }> };

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks.postgres?.status).toBe('up');
    expect(body.checks.sqs?.status).toBe('up');
  });

  it('GET /health/live generates a uuid v7 correlation id when none is sent', async () => {
    const response = await fetch(`${running.baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toMatch(UUID_V7);
    expect(await response.json()).toEqual({ status: 'ok', instanceId: 'it-api-1', role: 'api' });
  });

  it('echoes the incoming X-Correlation-Id', async () => {
    const response = await fetch(`${running.baseUrl}/health/live`, { headers: { 'X-Correlation-Id': 'it-corr-1' } });
    expect(response.headers.get('x-correlation-id')).toBe('it-corr-1');
  });

  it('GET /metrics exposes default process metrics in Prometheus format', async () => {
    const response = await fetch(`${running.baseUrl}/metrics`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(text).toContain('process_cpu_user_seconds_total{instance="it-api-1",role="api"}');
  });
});

describe('readiness with unreachable dependencies', () => {
  it('returns 503 when SQS is unreachable', async () => {
    const running = await startTestApp({ SQS_ENDPOINT: CLOSED_PORT_URL });
    try {
      const response = await fetch(`${running.baseUrl}/health/ready`);
      const body = (await response.json()) as { checks: Record<string, { status: string }> };

      expect(response.status).toBe(503);
      expect(body.checks.postgres?.status).toBe('up');
      expect(body.checks.sqs?.status).toBe('down');
    } finally {
      await running.close();
    }
  });

  it('returns 503 when PostgreSQL is unreachable, while liveness stays 200', async () => {
    const running = await startTestApp({ DATABASE_URL: 'postgresql://wagering:wagering@127.0.0.1:9/wagering' });
    try {
      const ready = await fetch(`${running.baseUrl}/health/ready`);
      const body = (await ready.json()) as { checks: Record<string, { status: string }> };
      const live = await fetch(`${running.baseUrl}/health/live`);

      expect(ready.status).toBe(503);
      expect(body.checks.postgres?.status).toBe('down');
      expect(body.checks.sqs?.status).toBe('up');
      expect(live.status).toBe(200);
    } finally {
      await running.close();
    }
  });
});
