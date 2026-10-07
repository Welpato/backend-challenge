import 'reflect-metadata';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import type { AppConfig } from '@/config/app-config';
import { loadConfig } from '@/config/load-config';
import { createSqsClient, SqsQueueUrls } from '@/messaging/sqs/sqs.client';

/**
 * Espera PostgreSQL e as filas do LocalStack ficarem prontos antes dos testes de integração
 * (o init do LocalStack cria as filas alguns segundos depois de a porta abrir).
 *
 *   NODE_ENV=test bun scripts/wait-for-infra.ts     # usa .env.test (infra de teste)
 *   WAIT_FOR_INFRA_TIMEOUT_MS=90000 bun scripts/wait-for-infra.ts
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_INTERVAL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postgresReady(config: AppConfig): Promise<void> {
  const sql = new SQL(config.database.url, { max: 1, connectionTimeout: 2 });
  try {
    await sql`select 1`;
  } finally {
    await sql.close();
  }
}

async function queuesReady(client: SQSClient, config: AppConfig): Promise<void> {
  const urls = new SqsQueueUrls(client);
  for (const name of Object.values(config.sqs.queues)) {
    const queueUrl = await urls.resolve(name);
    await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
  }
}

async function waitFor(name: string, check: () => Promise<void>, deadline: number): Promise<void> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      console.log(`${name}: ready`);
      return;
    } catch (error: unknown) {
      lastError = error;
      await sleep(RETRY_INTERVAL_MS);
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${name} not ready before timeout: ${reason}`);
}

const config = loadConfig();
const timeoutMs = Number.parseInt(process.env.WAIT_FOR_INFRA_TIMEOUT_MS ?? `${DEFAULT_TIMEOUT_MS}`, 10);
const deadline = Date.now() + timeoutMs;
const sqsClient = createSqsClient(config);

try {
  await waitFor('postgres', () => postgresReady(config), deadline);
  await waitFor('sqs', () => queuesReady(sqsClient, config), deadline);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  sqsClient.destroy();
}
