import type { Subprocess } from 'bun';
import type { AppRole } from '@/config/env.schema';
import { freePort, waitFor } from './subprocess';

/**
 * Harness multi-instância (F13): sobe N processos **reais** `bun src/main.ts` (um por instância, cada um com o
 * próprio pool de conexões e o próprio papel `APP_ROLE`) contra o PostgreSQL e o SQS da infra de teste
 * (`.env.test` já carregado neste processo). Nada é mockado e nada roda no processo do teste.
 *
 * Cada instância tem porta fixa (reaproveitada no `restart`), `INSTANCE_ID` próprio e log coletado em memória.
 */
export interface InstanceSpec {
  readonly role: Exclude<AppRole, 'all'>;
  readonly count: number;
  /** Ambiente extra só dessas instâncias (ex.: fault hook em um consumidor). */
  readonly env?: Readonly<Record<string, string>>;
}

type AppSubprocess = Subprocess<'ignore', 'pipe', 'pipe'>;

/** SIGTERM: o Nest fecha a app e reenvia o sinal a si mesmo (143); 0 também é saída limpa. */
export const GRACEFUL_EXIT_CODES: readonly number[] = [0, 143];

export class ClusterInstance {
  private proc: AppSubprocess | undefined;
  private readonly logs: string[] = [];
  private collecting: Promise<void> = Promise.resolve();

  constructor(
    readonly name: string,
    readonly role: InstanceSpec['role'],
    readonly port: number,
    private readonly env: Readonly<Record<string, string>>,
  ) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  isRunning(): boolean {
    return this.proc !== undefined && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  /** Sobe o processo (de novo, se já morreu) na mesma porta. Não espera a readiness. */
  spawn(): void {
    if (this.isRunning()) {
      throw new Error(`${this.name} is already running`);
    }
    this.logs.push(`--- spawn ${this.name} (${this.role}) at ${new Date().toISOString()} ---\n`);
    const proc = Bun.spawn(['bun', 'src/main.ts'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        ...this.env,
        APP_ROLE: this.role,
        INSTANCE_ID: this.name,
        PORT: String(this.port),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.proc = proc;
    // Consome a saída desde já: um pipe cheio bloquearia o processo.
    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        this.logs.push(decoder.decode(chunk));
      }
    };
    this.collecting = Promise.all([pump(proc.stdout), pump(proc.stderr)]).then(() => undefined);
  }

  /** Espera `/health/ready` responder 200 (PG + SQS alcançáveis, sem shutdown). */
  async waitReady(timeoutMs = 30_000): Promise<void> {
    await waitFor(
      async () => {
        if (!this.isRunning()) {
          throw new Error(`${this.name} exited (${this.proc?.exitCode ?? this.proc?.signalCode}):\n${this.output()}`);
        }
        const response = await fetch(`${this.baseUrl}/health/ready`).catch(() => undefined);
        return response?.status === 200;
      },
      timeoutMs,
      `${this.name} ready`,
      100,
    );
  }

  /** Envia o sinal e espera o processo sair; devolve o código de saída (ou 128 + n para sinal). */
  async kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<number> {
    const proc = this.proc;
    if (proc === undefined) {
      return 0;
    }
    if (this.isRunning()) {
      proc.kill(signal);
    }
    const code = await proc.exited;
    await this.collecting;
    return code;
  }

  /** Código de saída quando o processo terminar sozinho (ex.: fault hook). */
  async exited(): Promise<number> {
    const code = await (this.proc?.exited ?? Promise.resolve(0));
    await this.collecting;
    return code;
  }

  /** `kill` (se ainda vivo) + `spawn` na mesma porta + readiness. */
  async restart(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    await this.kill(signal);
    this.spawn();
    await this.waitReady();
  }

  /** Log acumulado (todas as vidas do processo). */
  output(): string {
    return this.logs.join('');
  }
}

export class Cluster {
  private constructor(readonly instances: readonly ClusterInstance[]) {}

  /**
   * Sobe todas as instâncias em paralelo e espera a readiness de todas. `commonEnv` vale para todas (filas
   * isoladas, intervalos curtos…); `InstanceSpec.env` sobrepõe por grupo.
   */
  static async start(
    specs: readonly InstanceSpec[],
    commonEnv: Readonly<Record<string, string>> = {},
  ): Promise<Cluster> {
    const instances: ClusterInstance[] = [];
    for (const spec of specs) {
      for (let index = 1; index <= spec.count; index += 1) {
        instances.push(
          new ClusterInstance(`mi-${spec.role}-${index}`, spec.role, freePort(), { ...commonEnv, ...spec.env }),
        );
      }
    }
    const cluster = new Cluster(instances);
    try {
      for (const instance of instances) {
        instance.spawn();
      }
      await Promise.all(instances.map((instance) => instance.waitReady()));
    } catch (error: unknown) {
      await cluster.stop();
      throw error;
    }
    return cluster;
  }

  byRole(role: InstanceSpec['role']): ClusterInstance[] {
    return this.instances.filter((instance) => instance.role === role);
  }

  /** URLs das APIs (alvo do `LoadClient`). */
  apiUrls(): string[] {
    return this.byRole('api').map((instance) => instance.baseUrl);
  }

  async killAll(signal: 'SIGTERM' | 'SIGKILL'): Promise<number[]> {
    return Promise.all(this.instances.map((instance) => instance.kill(signal)));
  }

  /** Sobe de novo todas as instâncias que não estão rodando (mesmas portas) e espera a readiness. */
  async restartStopped(): Promise<void> {
    const stopped = this.instances.filter((instance) => !instance.isRunning());
    for (const instance of stopped) {
      instance.spawn();
    }
    await Promise.all(stopped.map((instance) => instance.waitReady()));
  }

  /** Derruba tudo (SIGTERM, e SIGKILL para quem não sair em 15 s). Para o `afterAll`. */
  async stop(): Promise<void> {
    await Promise.all(
      this.instances.map(async (instance) => {
        const exited = await Promise.race([instance.kill('SIGTERM'), Bun.sleep(15_000).then(() => undefined)]);
        if (exited === undefined) {
          await instance.kill('SIGKILL');
        }
      }),
    );
  }

  /** Logs de todas as instâncias (diagnóstico de falha). */
  output(): string {
    return this.instances.map((instance) => `=== ${instance.name} ===\n${instance.output()}`).join('\n');
  }
}
