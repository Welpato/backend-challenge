/**
 * Leitura do formato texto do Prometheus para o teste de carga. Um snapshot = o `/metrics` de **todas** as
 * instâncias num instante; os resultados de cada cenário são diferenças entre dois snapshots, somadas entre as
 * instâncias (contadores e histogramas são por processo).
 */
export interface Sample {
  readonly name: string;
  readonly labels: ReadonlyMap<string, string>;
  readonly value: number;
}

/** instância → amostras do `/metrics` dela. */
export type MetricsSnapshot = ReadonlyMap<string, readonly Sample[]>;

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)(\s+\d+)?$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

export function parsePrometheusText(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = LINE.exec(line);
    if (match === null) {
      continue;
    }
    const labels = new Map<string, string>();
    for (const pair of (match[3] ?? '').matchAll(LABEL)) {
      labels.set(pair[1] ?? '', pair[2] ?? '');
    }
    const raw = match[4] ?? 'NaN';
    const value = raw === '+Inf' ? Number.POSITIVE_INFINITY : Number(raw);
    samples.push({ name: match[1] ?? '', labels, value });
  }
  return samples;
}

function matches(sample: Sample, name: string, filter: Readonly<Record<string, string>>): boolean {
  return sample.name === name && Object.entries(filter).every(([key, value]) => sample.labels.get(key) === value);
}

/** Soma de uma série (todas as instâncias) num snapshot. */
export function sumSeries(snapshot: MetricsSnapshot, name: string, filter: Readonly<Record<string, string>> = {}) {
  let total = 0;
  for (const samples of snapshot.values()) {
    for (const sample of samples) {
      if (matches(sample, name, filter)) {
        total += sample.value;
      }
    }
  }
  return total;
}

/**
 * Diferença de um contador entre dois snapshots, por instância (instância que reiniciou no meio — contador
 * zerado — conta só o valor final), somada.
 */
export function counterDelta(
  before: MetricsSnapshot,
  after: MetricsSnapshot,
  name: string,
  filter: Readonly<Record<string, string>> = {},
): number {
  let total = 0;
  for (const [instance, samples] of after) {
    const end = samples.filter((sample) => matches(sample, name, filter)).reduce((sum, s) => sum + s.value, 0);
    const start = (before.get(instance) ?? [])
      .filter((sample) => matches(sample, name, filter))
      .reduce((sum, s) => sum + s.value, 0);
    total += end >= start ? end - start : end;
  }
  return total;
}

/** Valores de um label presentes numa série (ex.: `type` de `wallet_lock_conflicts_total`). */
export function labelValues(snapshot: MetricsSnapshot, name: string, label: string): string[] {
  const values = new Set<string>();
  for (const samples of snapshot.values()) {
    for (const sample of samples) {
      const value = sample.labels.get(label);
      if (sample.name === name && value !== undefined) {
        values.add(value);
      }
    }
  }
  return [...values].sort();
}

export interface HistogramSummary {
  readonly count: number;
  readonly meanMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
}

/**
 * Histograma (`<name>_bucket`, `_sum`, `_count`) da janela entre os dois snapshots, somado entre instâncias.
 * Quantis estimados por interpolação linear dentro do bucket (como o `histogram_quantile` do Prometheus) — a
 * precisão é a dos buckets (1 ms … 10 s).
 */
export function histogramDelta(
  before: MetricsSnapshot,
  after: MetricsSnapshot,
  name: string,
  filter: Readonly<Record<string, string>> = {},
): HistogramSummary {
  const bounds = new Set<number>();
  for (const samples of after.values()) {
    for (const sample of samples) {
      const le = sample.labels.get('le');
      if (matches(sample, `${name}_bucket`, filter) && le !== undefined) {
        bounds.add(le === '+Inf' ? Number.POSITIVE_INFINITY : Number(le));
      }
    }
  }
  const sorted = [...bounds].sort((a, b) => a - b);
  const cumulative = sorted.map((bound) =>
    counterDelta(before, after, `${name}_bucket`, {
      ...filter,
      le: bound === Number.POSITIVE_INFINITY ? '+Inf' : formatLe(after, name, bound),
    }),
  );
  const count = counterDelta(before, after, `${name}_count`, filter);
  const sum = counterDelta(before, after, `${name}_sum`, filter);
  const quantile = (q: number): number | null => {
    if (count === 0) {
      return null;
    }
    const rank = q * count;
    for (let index = 0; index < sorted.length; index += 1) {
      const upTo = cumulative[index] ?? 0;
      if (upTo >= rank) {
        const upper = sorted[index] ?? 0;
        const lower = index === 0 ? 0 : (sorted[index - 1] ?? 0);
        const below = index === 0 ? 0 : (cumulative[index - 1] ?? 0);
        if (upper === Number.POSITIVE_INFINITY) {
          return lower * 1000;
        }
        const inBucket = upTo - below;
        const fraction = inBucket === 0 ? 1 : (rank - below) / inBucket;
        return (lower + (upper - lower) * fraction) * 1000;
      }
    }
    return null;
  };
  return {
    count,
    meanMs: count === 0 ? null : (sum / count) * 1000,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
  };
}

/** O texto exato do label `le` (o prom-client escreve `0.001`, `2.5`…), achado no próprio snapshot. */
function formatLe(snapshot: MetricsSnapshot, name: string, bound: number): string {
  for (const samples of snapshot.values()) {
    for (const sample of samples) {
      const le = sample.labels.get('le');
      if (sample.name === `${name}_bucket` && le !== undefined && Number(le) === bound) {
        return le;
      }
    }
  }
  return String(bound);
}
