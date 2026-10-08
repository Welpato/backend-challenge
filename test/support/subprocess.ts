import type { Subprocess } from 'bun';

/** Porta TCP livre (abre um servidor efêmero na porta 0 e fecha). */
export function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}

export interface AppProcess {
  readonly proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  readonly port: number;
  /** Encerra com SIGTERM (desligamento gracioso) e espera sair; devolve o código de saída. */
  terminate(): Promise<number>;
  /** stdout + stderr acumulados (diagnóstico quando o teste falha). */
  output(): Promise<string>;
}

/**
 * Sobe a aplicação real (`bun src/main.ts`) como **outro processo** — instância independente, com seu próprio
 * pool de conexões —, com o ambiente de teste (.env.test já carregado neste processo) mais `env`.
 */
export function spawnApp(env: Record<string, string>): AppProcess {
  const port = freePort();
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), LOG_LEVEL: 'warn', ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Consome a saída desde já: um pipe cheio bloquearia o processo filho.
  const collected = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
    ([stdout, stderr]) => `${stdout}\n${stderr}`,
  );
  return {
    proc,
    port,
    async terminate() {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGTERM');
      }
      return proc.exited;
    },
    output() {
      return collected;
    },
  };
}

/** Espera `condition` ficar verdadeira (polling), ou falha depois de `timeoutMs`. */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${description}`);
}
