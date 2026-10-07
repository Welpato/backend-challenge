/**
 * Probe de healthcheck do container (a imagem do Bun não traz curl/wget).
 * Consulta o `/health/ready` do próprio processo; exit 0 = healthy.
 *
 *   bun scripts/healthcheck.ts [live|ready]   # default: ready
 */
const PROBE_TIMEOUT_MS = 2500;

const probe = process.argv[2] === 'live' ? 'live' : 'ready';
// Lê PORT direto (sem o schema completo): o probe roda dentro do container com o mesmo ambiente.
const port = process.env.PORT ?? '3000';

try {
  const response = await fetch(`http://127.0.0.1:${port}/health/${probe}`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}

export {};
