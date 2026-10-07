import { describe, expect, it } from 'bun:test';
import { ConfigValidationError, loadConfig } from '@/config/load-config';

const BASE_ENV = { DATABASE_URL: 'postgresql://app:app@localhost:5432/wagering' } as const;

function issuesOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error: unknown) {
    if (error instanceof ConfigValidationError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error('expected loadConfig to fail');
}

describe('loadConfig', () => {
  it('applies development defaults when only DATABASE_URL is set', () => {
    const config = loadConfig(BASE_ENV);

    expect(config.role).toBe('all');
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
    expect(config.instanceId.length).toBeGreaterThan(0);
    expect(config.database).toStrictEqual({ url: BASE_ENV.DATABASE_URL, migrationUrl: undefined, lockTimeoutMs: 3000 });
    expect(config.sqs.endpoint).toBeUndefined();
    expect(config.sqs.region).toBe('us-east-1');
    expect(config.sqs.queues).toEqual({
      wagerTransactions: 'wager-transactions.fifo',
      wagerTransactionsDlq: 'wager-transactions-dlq.fifo',
      walletEvents: 'wallet-events.fifo',
    });
    expect(config.sqs.maxReceiveCount).toBe(5);
    expect(config.reprocessor).toEqual({
      intervalMs: 1000,
      pendingReferenceTtlMs: 1_800_000,
      pendingReferenceMaxAttempts: 12,
    });
    expect(config.faults.exitAfterCommit).toBe(false);
  });

  it('reads explicit values', () => {
    const config = loadConfig({
      ...BASE_ENV,
      APP_ROLE: 'consumer',
      PORT: '8081',
      INSTANCE_ID: 'consumer-2',
      LOG_LEVEL: 'debug',
      SQS_ENDPOINT: 'http://localstack:4566',
      AWS_REGION: 'sa-east-1',
      SQS_WAGER_QUEUE_NAME: 'custom.fifo',
      FAULT_EXIT_AFTER_COMMIT: '1',
    });

    expect(config.role).toBe('consumer');
    expect(config.port).toBe(8081);
    expect(config.instanceId).toBe('consumer-2');
    expect(config.logLevel).toBe('debug');
    expect(config.sqs.endpoint).toBe('http://localstack:4566');
    expect(config.sqs.region).toBe('sa-east-1');
    expect(config.sqs.queues.wagerTransactions).toBe('custom.fifo');
    expect(config.faults.exitAfterCommit).toBe(true);
  });

  it('treats empty variables as absent', () => {
    const config = loadConfig({ ...BASE_ENV, SQS_ENDPOINT: '', APP_ROLE: '  ', PORT: '' });

    expect(config.sqs.endpoint).toBeUndefined();
    expect(config.role).toBe('all');
    expect(config.port).toBe(3000);
  });

  it('reads the optional migrator connection separately from the app connection', () => {
    const migrationUrl = 'postgresql://migrator:migrator@localhost:5432/wagering';
    const config = loadConfig({ ...BASE_ENV, MIGRATION_DATABASE_URL: migrationUrl });

    expect(config.database.url).toBe(BASE_ENV.DATABASE_URL);
    expect(config.database.migrationUrl).toBe(migrationUrl);
    expect(issuesOf({ ...BASE_ENV, MIGRATION_DATABASE_URL: 'mysql://x@localhost/db' })).toEqual([
      'MIGRATION_DATABASE_URL: must be a postgres:// or postgresql:// URL',
    ]);
  });

  it('requires DATABASE_URL with a postgres scheme', () => {
    expect(issuesOf({}).some((issue) => issue.startsWith('DATABASE_URL'))).toBe(true);
    expect(issuesOf({ DATABASE_URL: 'mysql://x@localhost/db' }).some((i) => i.startsWith('DATABASE_URL'))).toBe(true);
  });

  it('reports every invalid variable at once', () => {
    const issues = issuesOf({
      ...BASE_ENV,
      APP_ROLE: 'worker',
      PORT: '3e3',
      LOG_LEVEL: 'verbose',
      SQS_ENDPOINT: 'localstack:4566',
      SQS_EVENTS_QUEUE_NAME: 'wallet-events',
      FAULT_EXIT_AFTER_COMMIT: 'yes',
    });

    const keys = issues.map((issue) => issue.split(':')[0]);
    expect(keys).toEqual(
      expect.arrayContaining([
        'APP_ROLE',
        'PORT',
        'LOG_LEVEL',
        'SQS_ENDPOINT',
        'SQS_EVENTS_QUEUE_NAME',
        'FAULT_EXIT_AFTER_COMMIT',
      ]),
    );
  });

  it('rejects out-of-range integers', () => {
    expect(issuesOf({ ...BASE_ENV, PORT: '70000' })[0]).toStartWith('PORT');
    expect(issuesOf({ ...BASE_ENV, SQS_WAIT_TIME_SECONDS: '21' })[0]).toStartWith('SQS_WAIT_TIME_SECONDS');
    expect(issuesOf({ ...BASE_ENV, DB_LOCK_TIMEOUT_MS: '-1' })[0]).toStartWith('DB_LOCK_TIMEOUT_MS');
  });
});
