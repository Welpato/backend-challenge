import type { AppConfig } from './app-config';
import { envSchema, type ParsedEnv } from './env.schema';

export class ConfigValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration: ${issues.join('; ')}`);
    this.name = 'ConfigValidationError';
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

/** Variáveis vazias (`VAR=`) contam como ausentes para que os defaults se apliquem. */
function withoutEmptyValues(env: EnvSource): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') {
      result[key] = value.trim();
    }
  }
  return result;
}

function toAppConfig(env: ParsedEnv): AppConfig {
  return {
    role: env.APP_ROLE,
    port: env.PORT,
    instanceId: env.INSTANCE_ID,
    logLevel: env.LOG_LEVEL,
    database: {
      url: env.DATABASE_URL,
      migrationUrl: env.MIGRATION_DATABASE_URL,
      lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
    },
    sqs: {
      endpoint: env.SQS_ENDPOINT,
      region: env.AWS_REGION,
      queues: {
        wagerTransactions: env.SQS_WAGER_QUEUE_NAME,
        wagerTransactionsDlq: env.SQS_WAGER_DLQ_NAME,
        walletEvents: env.SQS_EVENTS_QUEUE_NAME,
      },
      waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
      visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
      maxReceiveCount: env.SQS_MAX_RECEIVE_COUNT,
    },
    timeouts: {
      healthCheckMs: env.HEALTH_CHECK_TIMEOUT_MS,
      shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
    },
    outbox: {
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    },
    reprocessor: {
      intervalMs: env.REPROCESSOR_INTERVAL_MS,
      pendingReferenceTtlMs: env.PENDING_REFERENCE_TTL_MS,
      pendingReferenceMaxAttempts: env.PENDING_REFERENCE_MAX_ATTEMPTS,
    },
    faults: {
      exitAfterCommit: env.FAULT_EXIT_AFTER_COMMIT,
    },
  };
}

/**
 * Lê e valida o ambiente. Qualquer valor inválido lança `ConfigValidationError`
 * com todas as violações — o processo não sobe com configuração parcial.
 */
export function loadConfig(env: EnvSource = process.env): AppConfig {
  const result = envSchema.safeParse(withoutEmptyValues(env));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigValidationError(issues);
  }
  return toAppConfig(result.data);
}
