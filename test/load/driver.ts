import type { LoadInfra } from './infra';
import { type Channel, envelopeOf, type Operation } from './operations';

/**
 * Driver de carga em **malha fechada**: `concurrency` trabalhadores, cada um envia uma operação, espera a
 * resposta e envia a próxima, até acabar o tempo da fase. Mede a latência do cliente (HTTP: requisição →
 * resposta; SQS: `SendMessage`) e classifica cada resposta.
 */
export interface Outcome {
  readonly status: number;
  /** Rótulo do relatório: `201`, `200 replay`, `422 INSUFFICIENT_FUNDS`, `503 TRANSIENT_UNAVAILABLE`, `ERR`… */
  readonly label: string;
  readonly replay: boolean;
  /** A transação existe no banco com status final ou pendente (200/201/202/422). */
  readonly definitive: boolean;
  readonly latencyMs: number;
}

/** O que cada cenário fornece ao driver. */
export interface OperationSource {
  /**
   * `true` = metade dos trabalhadores envia pela fila (SQS) e metade por HTTP, com a fila limitada a nunca
   * passar o nº de requisições HTTP já respondidas — o mesmo volume pelos dois canais sem que um
   * `SendMessage` lento segure o HTTP (como aconteceria alternando canais no mesmo trabalhador).
   */
  readonly mixedChannels?: boolean;
  next(channel: Channel): Operation;
  /** Resultado de uma operação HTTP (ex.: BET confirmada entra no pool de REFUND). */
  onOutcome?(operation: Operation, outcome: Outcome): void;
}

/** Tudo que foi enviado no cenário (aquecimento + janela medida) — base das verificações finais. */
export class SentTracker {
  readonly sentKeys = new Set<string>();
  readonly definitiveKeys = new Set<string>();
  /** key → instante do `SendMessage` (ms, relógio do cliente) para a latência ponta a ponta da fila. */
  readonly sqsSentAt = new Map<string, number>();
}

export interface PhaseResult {
  readonly elapsedMs: number;
  readonly httpLatencies: number[];
  readonly byLabel: Map<string, number>;
  readonly duplicatesSent: number;
  readonly replays: number;
  readonly sqsSendLatencies: number[];
  readonly sqsSendErrors: number;
}

interface ErrorBody {
  readonly error?: { readonly code?: string };
}

interface SubmitBody {
  readonly status?: string;
  readonly failureCode?: string;
  readonly idempotentReplay?: boolean;
}

async function submitHttp(url: string, operation: Operation): Promise<Outcome> {
  const started = performance.now();
  try {
    const response = await fetch(`${url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': operation.key },
      body: JSON.stringify(operation.input),
    });
    const text = await response.text();
    const latencyMs = performance.now() - started;
    const body = (text === '' ? {} : JSON.parse(text)) as SubmitBody & ErrorBody;
    const replay = body.idempotentReplay === true;
    const definitive = [200, 201, 202, 422].includes(response.status);
    const detail = body.failureCode ?? body.error?.code;
    const label = [String(response.status), replay ? 'replay' : undefined, detail].filter(Boolean).join(' ');
    return { status: response.status, label, replay, definitive, latencyMs };
  } catch {
    return {
      status: 0,
      label: 'ERR connection',
      replay: false,
      definitive: false,
      latencyMs: performance.now() - started,
    };
  }
}

export async function runPhase(options: {
  readonly seconds: number;
  readonly concurrency: number;
  readonly apiUrls: readonly string[];
  readonly infra: LoadInfra;
  readonly source: OperationSource;
  readonly tracker: SentTracker;
}): Promise<PhaseResult> {
  const { apiUrls, infra, source, tracker } = options;
  const result: PhaseResult = {
    elapsedMs: 0,
    httpLatencies: [],
    byLabel: new Map(),
    duplicatesSent: 0,
    replays: 0,
    sqsSendLatencies: [],
    sqsSendErrors: 0,
  };
  let duplicates = 0;
  let replays = 0;
  let sqsErrors = 0;
  let nextUrl = 0;
  let httpDone = 0;
  let sqsStarted = 0;
  const started = performance.now();
  const deadline = started + options.seconds * 1000;

  const worker = async (index: number): Promise<void> => {
    const channel: Channel = source.mixedChannels === true && index % 2 === 1 ? 'sqs' : 'http';
    while (performance.now() < deadline) {
      if (channel === 'sqs' && sqsStarted >= httpDone) {
        await Bun.sleep(2);
        continue;
      }
      const operation = source.next(channel);
      if (channel === 'sqs') {
        sqsStarted += 1;
      }
      tracker.sentKeys.add(operation.key);
      if (operation.duplicate) {
        duplicates += 1;
      }
      if (operation.channel === 'sqs') {
        const sendStarted = performance.now();
        try {
          await infra.send(envelopeOf(operation, `msg-${operation.key}`), operation.input.walletId, operation.key);
          result.sqsSendLatencies.push(performance.now() - sendStarted);
          tracker.sqsSentAt.set(operation.key, Date.now());
        } catch {
          sqsErrors += 1;
        }
        continue;
      }
      nextUrl += 1;
      const outcome = await submitHttp(apiUrls[nextUrl % apiUrls.length] as string, operation);
      httpDone += 1;
      result.httpLatencies.push(outcome.latencyMs);
      result.byLabel.set(outcome.label, (result.byLabel.get(outcome.label) ?? 0) + 1);
      if (outcome.replay) {
        replays += 1;
      }
      if (outcome.definitive) {
        tracker.definitiveKeys.add(operation.key);
      }
      source.onOutcome?.(operation, outcome);
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, (_, index) => worker(index)));
  return {
    ...result,
    elapsedMs: performance.now() - started,
    duplicatesSent: duplicates,
    replays,
    sqsSendErrors: sqsErrors,
  };
}

export interface LatencySummary {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  readonly mean: number | null;
}

/** Percentis por posto mais próximo (nearest-rank) sobre as amostras ordenadas. */
export function summarize(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    return { count: 0, p50: null, p95: null, p99: null, max: null, mean: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  const round = (value: number): number => Math.round(value * 10) / 10;
  return {
    count: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}
