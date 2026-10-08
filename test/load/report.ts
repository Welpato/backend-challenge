import { mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, release, totalmem, type } from 'node:os';
import { join } from 'node:path';
import type { LatencySummary } from './driver';
import type { LoadInfra } from './infra';
import type { LoadConfig } from './load-config';
import type { HistogramSummary } from './prometheus';
import type { LoadTarget } from './target';
import type { DrainResult, VerificationResult } from './verification';

/** Relatório do teste de carga: JSON completo em disco + tabela resumida no terminal. */
export interface EnvironmentInfo {
  readonly startedAt: string;
  readonly target: LoadConfig['target'];
  readonly os: string;
  readonly cpu: string;
  readonly cpuCount: number;
  readonly memoryGb: number;
  readonly bun: string;
  readonly postgres: string;
  readonly docker: string | null;
  readonly replicas: Readonly<Record<string, number>>;
  readonly sqsEndpoint: string;
  readonly eventsSink: LoadConfig['eventsSink'];
  readonly warmupSeconds: number;
  readonly durationSeconds: number;
  readonly seed: number;
}

export interface ScenarioReport {
  readonly id: number;
  readonly name: string;
  readonly title: string;
  readonly concurrency: number;
  readonly wallets: number;
  readonly measuredSeconds: number;
  readonly http: {
    readonly requests: number;
    readonly throughputRps: number;
    readonly latencyMs: LatencySummary;
    readonly byCode: Readonly<Record<string, number>>;
    readonly errorRate: number;
    readonly duplicatesSent: number;
    readonly replays: number;
  };
  readonly queue: {
    readonly sent: number;
    readonly sendErrors: number;
    readonly sendLatencyMs: LatencySummary;
    readonly endToEndMs: LatencySummary;
    readonly processedRps: number;
  } | null;
  readonly server: {
    readonly walletLockConflicts: Readonly<Record<string, number>>;
    readonly walletLockWait: HistogramSummary;
    readonly processingHttp: HistogramSummary;
    readonly processingSqs: HistogramSummary;
    readonly idempotentReplays: number;
    readonly inboxDuplicates: number;
    readonly sqsRetries: number;
    readonly dlqMessages: number;
  };
  readonly outbox: {
    readonly maxLagSeconds: number;
    readonly lagAtLoadEndSeconds: number;
    readonly finalLagSeconds: number;
    readonly maxPending: number;
  };
  readonly drain: DrainResult;
  readonly reconciliation: VerificationResult;
}

async function commandOutput(command: readonly string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn([...command], { stdout: 'pipe', stderr: 'ignore' });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

export async function describeEnvironment(
  config: LoadConfig,
  target: LoadTarget,
  infra: LoadInfra,
): Promise<EnvironmentInfo> {
  const cpuList = cpus();
  const postgres = (await infra.db`select version() as v`) as { v: string }[];
  return {
    startedAt: new Date().toISOString(),
    target: config.target,
    os: `${type()} ${release()} ${arch()}`,
    cpu: cpuList[0]?.model ?? 'unknown',
    cpuCount: cpuList.length,
    memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    bun: Bun.version,
    postgres: (postgres[0]?.v ?? 'unknown').split(' on ')[0] ?? 'unknown',
    docker:
      config.target === 'compose'
        ? await commandOutput(['docker', 'version', '--format', '{{.Server.Version}}'])
        : null,
    replicas: target.replicas,
    sqsEndpoint: config.sqsEndpoint,
    eventsSink: config.eventsSink,
    warmupSeconds: config.warmupSeconds,
    durationSeconds: config.durationSeconds,
    seed: config.seed,
  };
}

export function writeReport(
  config: LoadConfig,
  environment: EnvironmentInfo,
  scenarios: readonly ScenarioReport[],
): string {
  mkdirSync(config.outputDir, { recursive: true });
  const file = join(config.outputDir, `load-${environment.startedAt.replace(/[:.]/g, '-')}.json`);
  const content = `${JSON.stringify({ environment, scenarios }, null, 2)}\n`;
  writeFileSync(file, content);
  writeFileSync(join(config.outputDir, 'latest.json'), content);
  return file;
}

const fmt = (value: number | null, digits = 1): string => (value === null ? '—' : value.toFixed(digits));

export function printSummary(environment: EnvironmentInfo, scenarios: readonly ScenarioReport[]): void {
  console.log(
    `\nAmbiente: ${environment.target} · ${environment.cpu} ×${environment.cpuCount} · ${environment.memoryGb} GB · ` +
      `Bun ${environment.bun} · ${environment.postgres} · réplicas ${JSON.stringify(environment.replicas)}`,
  );
  console.table(
    scenarios.map((scenario) => ({
      cenário: `${scenario.id} ${scenario.name}`,
      conc: scenario.concurrency,
      'req/s': fmt(scenario.http.throughputRps),
      'p50 ms': fmt(scenario.http.latencyMs.p50),
      'p95 ms': fmt(scenario.http.latencyMs.p95),
      'p99 ms': fmt(scenario.http.latencyMs.p99),
      'erro %': fmt(scenario.http.errorRate * 100, 2),
      'lock p95 ms': fmt(scenario.server.walletLockWait.p95Ms),
      'lock conflitos': Object.values(scenario.server.walletLockConflicts).reduce((sum, value) => sum + value, 0),
      'outbox lag máx s': fmt(scenario.outbox.maxLagSeconds, 2),
      'fila drena s': fmt(scenario.drain.queueDrainSeconds, 1),
      'outbox drena s': fmt(scenario.drain.outboxDrainSeconds, 1),
      reconciliação: `${scenario.reconciliation.apiConsistent}/${scenario.reconciliation.wallets} ${
        scenario.reconciliation.consistent ? 'OK' : 'FALHOU'
      }`,
    })),
  );
  for (const scenario of scenarios) {
    const codes = Object.entries(scenario.http.byCode)
      .map(([code, count]) => `${code}: ${count}`)
      .join(' · ');
    console.log(`  [${scenario.id}] respostas HTTP → ${codes}`);
    if (scenario.queue !== null) {
      console.log(
        `  [${scenario.id}] fila → ${scenario.queue.sent} enviadas, ponta a ponta p50 ${fmt(scenario.queue.endToEndMs.p50)} ms ` +
          `/ p95 ${fmt(scenario.queue.endToEndMs.p95)} ms, ${fmt(scenario.queue.processedRps)} msg/s processadas`,
      );
    }
  }
}
