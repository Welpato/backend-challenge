import type { INestApplication } from '@nestjs/common';
import { loadConfig } from '@/config/load-config';
import { createApp } from '@/create-app';

export interface RunningTestApp {
  readonly baseUrl: string;
  readonly app: INestApplication;
  close(): Promise<void>;
}

/**
 * Sobe a aplicação real (mesmo `createApp` do `main.ts`) numa porta livre, com o ambiente de
 * teste (.env.test) mais `overrides`. Nada é mockado: PG e SQS são os da infra de teste.
 */
export async function startTestApp(overrides: Record<string, string> = {}): Promise<RunningTestApp> {
  const config = loadConfig({ ...process.env, ...overrides });
  const app = await createApp(config);
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (address === null || typeof address === 'string') {
    throw new Error('Unexpected server address');
  }
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}
