import { seededRandom } from '../support/seeded-random';
import { type PhaseResult, runPhase, SentTracker, summarize } from './driver';
import { EventSink, LoadInfra } from './infra';
import { loadLoadConfig } from './load-config';
import { type LoadWallet, OperationFactory, openWallets } from './operations';
import { counterDelta, histogramDelta, labelValues } from './prometheus';
import { describeEnvironment, printSummary, type ScenarioReport, writeReport } from './report';
import { SCENARIOS, type ScenarioDefinition } from './scenarios';
import { type LoadTarget, openTarget } from './target';
import { OutboxSampler, queueEndToEndMs, verifyScenario, waitForQuiescence } from './verification';

/**
 * Teste de carga (F16) — `bun run test:load`. Roda os cenários escolhidos em sequência contra a stack de pé
 * (`LOAD_TARGET=compose`, default) ou contra réplicas que ele mesmo sobe (`LOAD_TARGET=local`). Por cenário:
 * abre as wallets → aquecimento (descartado) → espera a fila/outbox esvaziarem → snapshot das métricas de todas
 * as instâncias → janela medida → espera esvaziar de novo (tempo medido) → snapshot → reconciliação de todas
 * as wallets. Sai com código 1 se alguma reconciliação não fechar 100%. Metodologia e análise: LOAD_TEST.md.
 */
const config = loadLoadConfig();
const runId = `L${Date.now().toString(36)}`;

function log(message: string): void {
  console.log(`[load ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

async function runScenario(
  definition: ScenarioDefinition,
  target: LoadTarget,
  infra: LoadInfra,
): Promise<ScenarioReport> {
  const prefix = `${runId}-s${definition.id}`;
  const random = seededRandom(config.seed + definition.id);
  log(`cenário ${definition.id} — ${definition.title}: abrindo ${definition.walletCount} wallet(s)`);
  const wallets: LoadWallet[] = await openWallets(
    target.apiUrls,
    prefix,
    definition.walletCount,
    definition.initialAmount,
  );
  const factory = new OperationFactory(prefix, random);
  const source = definition.createSource(wallets, factory, random);
  const tracker = new SentTracker();
  const dlqBaseline = await infra.queueDepth(infra.dlqUrl);
  const phase = (seconds: number): Promise<PhaseResult> =>
    runPhase({ seconds, concurrency: definition.concurrency, apiUrls: target.apiUrls, infra, source, tracker });

  if (config.warmupSeconds > 0) {
    log(`cenário ${definition.id}: aquecimento de ${config.warmupSeconds}s`);
    await phase(config.warmupSeconds);
    await waitForQuiescence(infra, wallets, tracker, definition.usesQueue, config.drainTimeoutSeconds);
  }
  const warmupQueueKeys = new Set(tracker.sqsSentAt.keys());

  const before = await target.scrape();
  const sampler = new OutboxSampler(infra);
  sampler.start();
  log(`cenário ${definition.id}: janela medida de ${config.durationSeconds}s (concorrência ${definition.concurrency})`);
  const measured = await phase(config.durationSeconds);
  await sampler.sample();
  const lagAtLoadEndSeconds = sampler.lastLagSeconds;
  log(`cenário ${definition.id}: carga encerrada, esperando fila/outbox esvaziarem`);
  const drain = await waitForQuiescence(infra, wallets, tracker, definition.usesQueue, config.drainTimeoutSeconds);
  await sampler.stop();
  const finalStatus = await infra.outboxStatus();
  const after = await target.scrape();

  log(`cenário ${definition.id}: reconciliando ${wallets.length} wallet(s)`);
  const reconciliation = await verifyScenario(infra, target.apiUrls[0] as string, wallets, tracker, dlqBaseline);

  const measuredSeconds = measured.elapsedMs / 1000;
  const httpRequests = measured.httpLatencies.length;
  const failures = [...measured.byLabel.entries()]
    .filter(([label]) => !/^(200|201|202|422)\b/.test(label))
    .reduce((sum, [, count]) => sum + count, 0);
  const measuredQueueKeys = [...tracker.sqsSentAt.keys()].filter((key) => !warmupQueueKeys.has(key));
  const endToEnd = definition.usesQueue ? await measuredEndToEnd(infra, tracker, measuredQueueKeys) : [];
  const lockTypes = new Set([
    'timeout',
    'deadlock',
    'version',
    ...labelValues(after, 'wallet_lock_conflicts_total', 'type'),
  ]);
  const walletLockConflicts: Record<string, number> = {};
  for (const type of lockTypes) {
    walletLockConflicts[type] = counterDelta(before, after, 'wallet_lock_conflicts_total', { type });
  }

  return {
    id: definition.id,
    name: definition.name,
    title: definition.title,
    concurrency: definition.concurrency,
    wallets: wallets.length,
    measuredSeconds: Math.round(measuredSeconds * 10) / 10,
    http: {
      requests: httpRequests,
      throughputRps: Math.round((httpRequests / measuredSeconds) * 10) / 10,
      latencyMs: summarize(measured.httpLatencies),
      byCode: Object.fromEntries([...measured.byLabel.entries()].sort(([a], [b]) => a.localeCompare(b))),
      errorRate: httpRequests === 0 ? 0 : failures / httpRequests,
      duplicatesSent: measured.duplicatesSent,
      replays: measured.replays,
    },
    queue: definition.usesQueue
      ? {
          sent: measured.sqsSendLatencies.length,
          sendErrors: measured.sqsSendErrors,
          sendLatencyMs: summarize(measured.sqsSendLatencies),
          endToEndMs: summarize(endToEnd),
          processedRps:
            Math.round((measuredQueueKeys.length / (measuredSeconds + (drain.queueDrainSeconds ?? 0))) * 10) / 10,
        }
      : null,
    server: {
      walletLockConflicts,
      walletLockWait: histogramDelta(before, after, 'wallet_lock_wait_seconds'),
      processingHttp: histogramDelta(before, after, 'processing_duration_seconds', { source: 'http' }),
      processingSqs: histogramDelta(before, after, 'processing_duration_seconds', { source: 'sqs' }),
      idempotentReplays: counterDelta(before, after, 'idempotent_replays_total'),
      inboxDuplicates: counterDelta(before, after, 'inbox_duplicates_total'),
      sqsRetries: counterDelta(before, after, 'sqs_retries_total'),
      dlqMessages: counterDelta(before, after, 'sqs_dlq_messages_total'),
    },
    outbox: {
      maxLagSeconds: round2(sampler.maxLagSeconds),
      lagAtLoadEndSeconds: round2(lagAtLoadEndSeconds),
      finalLagSeconds: round2(finalStatus.lagSeconds),
      maxPending: sampler.maxPending,
    },
    drain: {
      queueDrainSeconds: drain.queueDrainSeconds === null ? null : round2(drain.queueDrainSeconds),
      outboxDrainSeconds: round2(drain.outboxDrainSeconds),
    },
    reconciliation,
  };
}

/** Ponta a ponta só das mensagens enviadas na janela medida (as do aquecimento ficam de fora). */
async function measuredEndToEnd(infra: LoadInfra, tracker: SentTracker, keys: readonly string[]): Promise<number[]> {
  const subset = new SentTracker();
  for (const key of keys) {
    subset.sqsSentAt.set(key, tracker.sqsSentAt.get(key) as number);
  }
  return queueEndToEndMs(infra, subset);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function main(): Promise<void> {
  log(`alvo ${config.target}, cenários ${config.scenarios.join(',')}, run ${runId}`);
  const infra = await LoadInfra.open(config);
  const target = await openTarget(config);
  const sink = new EventSink(infra, config.eventsSink);
  sink.start();
  const reports: ScenarioReport[] = [];
  try {
    const environment = await describeEnvironment(config, target, infra);
    for (const id of config.scenarios) {
      const definition = SCENARIOS.find((scenario) => scenario.id === id) as ScenarioDefinition;
      reports.push(await runScenario(definition, target, infra));
    }
    const file = writeReport(config, environment, reports);
    printSummary(environment, reports);
    log(`relatório JSON: ${file}`);
  } finally {
    await sink.stop();
    log(`eventos retirados da fila de eventos (downstream, ${config.eventsSink}): ${sink.consumed}`);
    await target.close();
    await infra.close();
  }
  const failed = reports.filter((report) => !report.reconciliation.consistent);
  if (failed.length > 0) {
    console.error(`Reconciliação NÃO consistente nos cenários: ${failed.map((report) => report.id).join(', ')}`);
    for (const report of failed) {
      console.error(JSON.stringify(report.reconciliation));
    }
    process.exit(1);
  }
  log('reconciliação 100% consistente em todos os cenários');
}

await main();
