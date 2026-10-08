/**
 * Leitura do `/metrics` (formato texto do Prometheus) da app real. Soma as séries do nome pedido cujos labels
 * contêm `labels` (labels default de instância são ignorados). Série inexistente → 0.
 */
export async function metricValue(
  baseUrl: string,
  name: string,
  labels: Readonly<Record<string, string>> = {},
): Promise<number> {
  const text = await (await fetch(`${baseUrl}/metrics`)).text();
  let total = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) {
      continue;
    }
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)$/.exec(line);
    if (match === null || match[1] !== name) {
      continue;
    }
    const seriesLabels = new Map<string, string>();
    for (const pair of (match[3] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      seriesLabels.set(pair[1] ?? '', pair[2] ?? '');
    }
    if (Object.entries(labels).every(([key, value]) => seriesLabels.get(key) === value)) {
      total += Number(match[4]);
    }
  }
  return total;
}
