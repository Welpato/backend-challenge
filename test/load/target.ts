import { Cluster } from '../support/cluster';
import type { LoadConfig } from './load-config';
import { type MetricsSnapshot, parsePrometheusText, type Sample } from './prometheus';

/**
 * Alvo do teste de carga: para onde vão as requisições HTTP e de onde vêm as métricas de cada processo.
 *
 * - `compose`: a stack do `docker-compose.yml` já está de pé. HTTP vai para o nginx (que distribui entre as
 *   réplicas `api`); como o `/metrics` atrás do nginx cai numa réplica qualquer, cada container
 *   (`api`, `consumer`, `outbox`, `reprocessor`) é lido por `docker exec <container> bun -e "fetch(...)"`.
 * - `local`: o próprio script sobe as réplicas como processos `bun src/main.ts` (mesmo harness da F13) contra a
 *   infra do `.env`/`LOAD_*`; sem nginx, o cliente faz round-robin entre as APIs.
 */
export interface LoadTarget {
  readonly kind: LoadConfig['target'];
  /** URLs das APIs; o driver alterna entre elas (no `compose` é só o nginx). */
  readonly apiUrls: readonly string[];
  /** Réplicas por papel (para o relatório). */
  readonly replicas: Readonly<Record<string, number>>;
  scrape(): Promise<MetricsSnapshot>;
  close(): Promise<void>;
}

const ROLES = ['api', 'consumer', 'outbox', 'reprocessor'] as const;
const IN_CONTAINER_SCRAPE =
  "const r = await fetch('http://127.0.0.1:3000/metrics'); process.stdout.write(await r.text());";

interface ComposeContainer {
  readonly Name: string;
  readonly Service: string;
  readonly State: string;
}

async function run(command: readonly string[]): Promise<string> {
  const proc = Bun.spawn([...command], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${command.join(' ')} exited with ${code}: ${stderr.trim()}`);
  }
  return stdout;
}

function parseComposePs(output: string): ComposeContainer[] {
  const trimmed = output.trim();
  if (trimmed === '') {
    return [];
  }
  // Compose v2 antigo devolve um array; o atual, um objeto JSON por linha.
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as ComposeContainer[];
  }
  return trimmed.split('\n').map((line) => JSON.parse(line) as ComposeContainer);
}

class ComposeTarget implements LoadTarget {
  readonly kind = 'compose' as const;

  private constructor(
    readonly apiUrls: readonly string[],
    private readonly containers: readonly ComposeContainer[],
    readonly replicas: Readonly<Record<string, number>>,
  ) {}

  static async open(config: LoadConfig): Promise<ComposeTarget> {
    const all = parseComposePs(await run(['docker', 'compose', 'ps', '--format', 'json']));
    const containers = all.filter(
      (container) => (ROLES as readonly string[]).includes(container.Service) && container.State === 'running',
    );
    if (containers.length === 0) {
      throw new Error('No running api/worker containers found. Run `docker compose up -d --build` first.');
    }
    const replicas: Record<string, number> = {};
    for (const role of ROLES) {
      replicas[role] = containers.filter((container) => container.Service === role).length;
    }
    const ready = await fetch(`${config.baseUrl}/health/ready`).catch(() => undefined);
    if (ready?.status !== 200) {
      throw new Error(`${config.baseUrl}/health/ready is not 200 — is the stack (nginx) up?`);
    }
    return new ComposeTarget([config.baseUrl], containers, replicas);
  }

  async scrape(): Promise<MetricsSnapshot> {
    const entries = await Promise.all(
      this.containers.map(async (container): Promise<[string, Sample[]]> => {
        const text = await run(['docker', 'exec', container.Name, 'bun', '-e', IN_CONTAINER_SCRAPE]).catch(() => '');
        return [container.Name, parsePrometheusText(text)];
      }),
    );
    return new Map(entries);
  }

  async close(): Promise<void> {}
}

class LocalClusterTarget implements LoadTarget {
  readonly kind = 'local' as const;

  private constructor(
    private readonly cluster: Cluster,
    readonly replicas: Readonly<Record<string, number>>,
  ) {}

  get apiUrls(): readonly string[] {
    return this.cluster.apiUrls();
  }

  static async open(config: LoadConfig): Promise<LocalClusterTarget> {
    const cluster = await Cluster.start(
      ROLES.map((role) => ({ role, count: config.localReplicas })),
      {
        NODE_ENV: 'development',
        LOG_LEVEL: 'warn',
        DATABASE_URL: config.databaseUrl,
        SQS_ENDPOINT: config.sqsEndpoint,
      },
    );
    const replicas: Record<string, number> = {};
    for (const role of ROLES) {
      replicas[role] = config.localReplicas;
    }
    return new LocalClusterTarget(cluster, replicas);
  }

  async scrape(): Promise<MetricsSnapshot> {
    const entries = await Promise.all(
      this.cluster.instances.map(async (instance): Promise<[string, Sample[]]> => {
        const text = await fetch(`${instance.baseUrl}/metrics`)
          .then((response) => response.text())
          .catch(() => '');
        return [instance.name, parsePrometheusText(text)];
      }),
    );
    return new Map(entries);
  }

  async close(): Promise<void> {
    await this.cluster.stop();
  }
}

export async function openTarget(config: LoadConfig): Promise<LoadTarget> {
  return config.target === 'compose' ? ComposeTarget.open(config) : LocalClusterTarget.open(config);
}
