/**
 * Configuração do teste de carga (F16), lida do ambiente. Tudo tem default para que `bun run test:load` funcione
 * logo depois de `docker compose up -d --build`, sem `.env`.
 *
 * | Variável | Default | Significado |
 * |---|---|---|
 * | `LOAD_TARGET` | `compose` | `compose` = stack do `docker-compose.yml` (API pelo nginx, métricas por `docker exec`); `local` = o próprio script sobe as réplicas com `bun src/main.ts` contra a infra do `.env` |
 * | `LOAD_BASE_URL` | `http://localhost:${NGINX_PORT:-8082}` | API (nginx) no modo `compose` |
 * | `LOAD_DATABASE_URL` | `DATABASE_URL` ou `postgresql://app:app@localhost:5432/wagering` | leitura do lag da outbox e verificações SQL |
 * | `LOAD_SQS_ENDPOINT` | `SQS_ENDPOINT` ou `http://localhost:4566` | envio do cenário 4 e espera da fila esvaziar |
 * | `LOAD_SCENARIOS` | `1,2,3,4` | subconjunto dos cenários |
 * | `LOAD_WARMUP_SECONDS` | `5` | aquecimento por cenário (fora das métricas) |
 * | `LOAD_DURATION_SECONDS` | `30` | janela medida por cenário |
 * | `LOAD_DRAIN_TIMEOUT_SECONDS` | `300` | espera máxima da fila/outbox esvaziarem |
 * | `LOAD_SEED` | `20261008` | semente do PRNG (mix de operações reprodutível) |
 * | `LOAD_OUTPUT_DIR` | `test/load/results` | onde o JSON é gravado |
 * | `LOAD_LOCAL_REPLICAS` | `3` | réplicas por papel no modo `local` |
 * | `LOAD_EVENTS_SINK` | `consume` | destino downstream da `wallet-events.fifo`: `consume`, `purge` (só emulador) ou `off` (ver `EventSink`) |
 */
export type LoadTargetKind = 'compose' | 'local';

export interface LoadConfig {
  readonly target: LoadTargetKind;
  readonly baseUrl: string;
  readonly databaseUrl: string;
  readonly sqsEndpoint: string;
  readonly awsRegion: string;
  readonly wagerQueueName: string;
  readonly dlqName: string;
  readonly eventsQueueName: string;
  readonly eventsSink: 'consume' | 'purge' | 'off';
  readonly scenarios: readonly number[];
  readonly warmupSeconds: number;
  readonly durationSeconds: number;
  readonly drainTimeoutSeconds: number;
  readonly seed: number;
  readonly outputDir: string;
  readonly localReplicas: number;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, allowZero = false): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const value = Number.parseInt(raw, 10);
  if (value === 0 && !allowZero) {
    throw new Error(`${name} must be > 0`);
  }
  return value;
}

function parseSink(value: string): LoadConfig['eventsSink'] {
  if (value !== 'consume' && value !== 'purge' && value !== 'off') {
    throw new Error('LOAD_EVENTS_SINK must be consume, purge or off');
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export function loadLoadConfig(env: NodeJS.ProcessEnv = process.env): LoadConfig {
  const target = nonEmpty(env.LOAD_TARGET) ?? 'compose';
  if (target !== 'compose' && target !== 'local') {
    throw new Error('LOAD_TARGET must be "compose" or "local"');
  }
  const scenarios = (nonEmpty(env.LOAD_SCENARIOS) ?? '1,2,3,4').split(',').map((part) => {
    const value = Number.parseInt(part.trim(), 10);
    if (![1, 2, 3, 4].includes(value)) {
      throw new Error('LOAD_SCENARIOS must be a comma-separated subset of 1,2,3,4');
    }
    return value;
  });
  return {
    target,
    baseUrl: nonEmpty(env.LOAD_BASE_URL) ?? `http://localhost:${nonEmpty(env.NGINX_PORT) ?? '8082'}`,
    databaseUrl:
      nonEmpty(env.LOAD_DATABASE_URL) ?? nonEmpty(env.DATABASE_URL) ?? 'postgresql://app:app@localhost:5432/wagering',
    sqsEndpoint: nonEmpty(env.LOAD_SQS_ENDPOINT) ?? nonEmpty(env.SQS_ENDPOINT) ?? 'http://localhost:4566',
    awsRegion: nonEmpty(env.AWS_REGION) ?? 'us-east-1',
    wagerQueueName: nonEmpty(env.SQS_WAGER_QUEUE_NAME) ?? 'wager-transactions.fifo',
    dlqName: nonEmpty(env.SQS_WAGER_DLQ_NAME) ?? 'wager-transactions-dlq.fifo',
    eventsQueueName: nonEmpty(env.SQS_EVENTS_QUEUE_NAME) ?? 'wallet-events.fifo',
    eventsSink: parseSink(nonEmpty(env.LOAD_EVENTS_SINK) ?? 'consume'),
    scenarios,
    warmupSeconds: positiveInt(env, 'LOAD_WARMUP_SECONDS', 5, true),
    durationSeconds: positiveInt(env, 'LOAD_DURATION_SECONDS', 30),
    drainTimeoutSeconds: positiveInt(env, 'LOAD_DRAIN_TIMEOUT_SECONDS', 300),
    seed: positiveInt(env, 'LOAD_SEED', 20261008, true),
    outputDir: nonEmpty(env.LOAD_OUTPUT_DIR) ?? 'test/load/results',
    localReplicas: positiveInt(env, 'LOAD_LOCAL_REPLICAS', 3),
  };
}
