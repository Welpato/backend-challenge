import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { closeDb } from '../../support/db';
import { type RunningTestApp, startTestApp } from '../../support/test-app';
import { createWallet, expectError, getJson } from './wallet-test-kit';

describe('HTTP error mapping', () => {
  let running: RunningTestApp;

  beforeAll(async () => {
    running = await startTestApp({ INSTANCE_ID: 'it-wallet-errors' });
  });

  afterAll(async () => {
    await running.close();
    await closeDb();
  });

  it('answers unknown routes with the uniform error body (404 NOT_FOUND)', async () => {
    expectError(await getJson(running.baseUrl, '/does-not-exist'), 404, 'NOT_FOUND');
  });

  it('echoes the request correlation id in the error body and header', async () => {
    const response = await fetch(`${running.baseUrl}/wallets/${crypto.randomUUID()}`, {
      headers: { 'x-correlation-id': 'corr-err-1' },
    });
    const body = (await response.json()) as { error: { correlationId: string } };
    expect(response.status).toBe(404);
    expect(response.headers.get('x-correlation-id')).toBe('corr-err-1');
    expect(body.error.correlationId).toBe('corr-err-1');
  });

  it('keeps health and metrics open (no provider authentication)', async () => {
    expect((await fetch(`${running.baseUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${running.baseUrl}/metrics`)).status).toBe(200);
  });
});

describe('transient failures', () => {
  let running: RunningTestApp;

  beforeAll(async () => {
    // PostgreSQL inalcançável: porta fechada → ECONNREFUSED, classificado como falha transitória de conexão.
    running = await startTestApp({
      INSTANCE_ID: 'it-wallet-pg-down',
      DATABASE_URL: 'postgresql://app:app@127.0.0.1:1/wagering',
    });
  });

  afterAll(async () => {
    await running.close();
  });

  it('maps an unreachable database to 503 TRANSIENT_UNAVAILABLE with Retry-After: 1', async () => {
    const read = await getJson(running.baseUrl, `/wallets/${crypto.randomUUID()}`);
    expectError(read, 503, 'TRANSIENT_UNAVAILABLE');
    expect(read.headers.get('retry-after')).toBe('1');

    const write = await createWallet(running.baseUrl, { playerId: 'p', currency: 'BRL' });
    expectError(write, 503, 'TRANSIENT_UNAVAILABLE');
    expect(write.headers.get('retry-after')).toBe('1');
  });
});
