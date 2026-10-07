import { hostname } from 'node:os';
import { z } from 'zod';

export const APP_ROLES = ['api', 'consumer', 'outbox', 'reprocessor', 'all'] as const;
export type AppRole = (typeof APP_ROLES)[number];

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Inteiro em string decimal, sem sinal, sem notação científica e sem casas decimais.
 * Usado só para portas, timeouts e contadores de configuração (nunca para dinheiro).
 */
function intSetting(defaultValue: number, min: number, max: number) {
  return z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer')
    .default(String(defaultValue))
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().min(min).max(max));
}

/** Flags aceitam apenas `0`/`1`/`true`/`false` — qualquer outro valor derruba o boot. */
function flagSetting() {
  return z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((value) => value === '1' || value === 'true');
}

function fifoQueueName(defaultValue: string) {
  return z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,75}\.fifo$/, 'must be a FIFO queue name ending in .fifo')
    .default(defaultValue);
}

/**
 * Schema das variáveis de ambiente. Variáveis vazias são tratadas como ausentes
 * (o Compose costuma repassar `VAR=` vazio). `DATABASE_URL` (role `app`) é a única obrigatória;
 * o resto tem default de desenvolvimento. Credenciais AWS ficam fora do schema:
 * o SDK as lê da cadeia padrão (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`).
 */
export const envSchema = z.object({
  APP_ROLE: z.enum(APP_ROLES).default('all'),
  PORT: intSetting(3000, 1, 65535),
  INSTANCE_ID: z.string().min(1).max(128).default(hostname()),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// or postgresql:// URL' }),
  /** Conexão do DDL (role `migrator`). Ausente = `DATABASE_URL` (ex.: job `migrate` do Compose). */
  MIGRATION_DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// or postgresql:// URL' })
    .optional(),
  DB_LOCK_TIMEOUT_MS: intSetting(3000, 1, 60_000),

  SQS_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  AWS_REGION: z
    .string()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'must be an AWS region like us-east-1')
    .default('us-east-1'),
  SQS_WAGER_QUEUE_NAME: fifoQueueName('wager-transactions.fifo'),
  SQS_WAGER_DLQ_NAME: fifoQueueName('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE_NAME: fifoQueueName('wallet-events.fifo'),
  SQS_WAIT_TIME_SECONDS: intSetting(20, 0, 20),
  SQS_VISIBILITY_TIMEOUT_SECONDS: intSetting(30, 0, 43_200),
  SQS_MAX_RECEIVE_COUNT: intSetting(5, 1, 1000),

  HEALTH_CHECK_TIMEOUT_MS: intSetting(2000, 100, 30_000),
  SHUTDOWN_GRACE_MS: intSetting(20_000, 0, 120_000),

  OUTBOX_POLL_INTERVAL_MS: intSetting(250, 10, 60_000),
  REPROCESSOR_INTERVAL_MS: intSetting(1000, 10, 60_000),
  PENDING_REFERENCE_TTL_MS: intSetting(30 * 60_000, 1000, 24 * 60 * 60_000),
  PENDING_REFERENCE_MAX_ATTEMPTS: intSetting(12, 1, 1000),

  FAULT_EXIT_AFTER_COMMIT: flagSetting(),
});

export type RawEnv = z.input<typeof envSchema>;
export type ParsedEnv = z.output<typeof envSchema>;
