import { describe, expect, it } from 'bun:test';
import { Writable } from 'node:stream';
import pino from 'pino';
import { loadConfig } from '@/config/load-config';
import { runWithCorrelation } from '@/shared/observability/correlation';
import { buildLoggerOptions } from '@/shared/observability/logger.module';

function captureLogger(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const config = loadConfig({
    DATABASE_URL: 'postgresql://app:app@localhost:5432/wagering',
    INSTANCE_ID: 'api-7',
    APP_ROLE: 'api',
    LOG_LEVEL: 'info',
  });
  const { genReqId: _genReqId, customLogLevel: _customLogLevel, ...pinoOptions } = buildLoggerOptions(config);
  const logger = pino(pinoOptions, stream);
  return {
    logger,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('logger options', () => {
  it('writes JSON lines with instanceId, role, level label and ISO time', () => {
    const { logger, lines } = captureLogger();
    logger.info('hello');

    const [line] = lines();
    expect(line).toMatchObject({ level: 'info', instanceId: 'api-7', role: 'api', msg: 'hello' });
    expect(typeof line?.time).toBe('string');
  });

  it('adds the correlationId from the async context', () => {
    const { logger, lines } = captureLogger();
    runWithCorrelation({ correlationId: 'corr-9' }, () => logger.info('inside'));
    logger.info('outside');

    const [inside, outside] = lines();
    expect(inside?.correlationId).toBe('corr-9');
    expect(outside?.correlationId).toBeUndefined();
  });

  it('redacts money, balances, amounts and request bodies', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        walletId: 'w-1',
        money: { amount: '25.00', currency: 'BRL' },
        balance: '1000.00',
        transaction: { amount: '10.00', balanceAfter: '990.00', balance_before: '1000.00' },
        result: { wallet: { balance: '1.00' } },
        req: { method: 'POST', body: { money: { amount: '25.00' } } },
      },
      'processed',
    );

    const [line] = lines();
    expect(line?.walletId).toBe('w-1');
    expect(line?.money).toBe('[REDACTED]');
    expect(line?.balance).toBe('[REDACTED]');
    expect(line?.transaction).toEqual({
      amount: '[REDACTED]',
      balanceAfter: '[REDACTED]',
      balance_before: '[REDACTED]',
    });
    expect(line?.result).toEqual({ wallet: { balance: '[REDACTED]' } });
    expect(line?.req).toEqual({ method: 'POST', body: '[REDACTED]' });
    expect(JSON.stringify(line)).not.toContain('25.00');
  });
  it('redacts database error details and query parameters that may carry amounts', () => {
    const { logger, lines } = captureLogger();
    const error = Object.assign(new Error('new row violates check constraint'), {
      detail: 'Failing row contains (w-1, p-1, BRL, -25.00, 1).',
      parameters: ['-25.00'],
    });
    logger.error({ err: error }, 'Unexpected database error');

    const serialized = JSON.stringify(lines());
    expect(serialized).not.toContain('25.00');
    expect(serialized).toContain('check constraint');
  });
});
