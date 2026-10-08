import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '@/config/app-config';

/**
 * Cliente SQS. Com endpoint customizado (LocalStack) o endpoint configurado sempre vence a URL
 * devolvida pela fila (`useQueueUrlAsEndpoint: false`), para não depender do hostname que o
 * LocalStack escreve nas URLs.
 */
export function createSqsClient(config: AppConfig): SQSClient {
  const { endpoint, region } = config.sqs;
  if (endpoint === undefined) {
    return new SQSClient({ region });
  }
  return new SQSClient({ region, endpoint, useQueueUrlAsEndpoint: false });
}

/**
 * Resolve a URL de uma fila pelo nome (`GetQueueUrl`) e memoriza o resultado.
 * A URL é estável durante a vida do processo; só sucessos entram no cache.
 */
export class SqsQueueUrls {
  private readonly cache = new Map<string, string>();

  constructor(private readonly client: SQSClient) {}

  async resolve(queueName: string, abortSignal?: AbortSignal): Promise<string> {
    const cached = this.cache.get(queueName);
    if (cached !== undefined) {
      return cached;
    }
    const options = abortSignal === undefined ? {} : { abortSignal };
    const output = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }), options);
    if (output.QueueUrl === undefined) {
      throw new Error(`Queue URL not returned for ${queueName}`);
    }
    this.cache.set(queueName, output.QueueUrl);
    return output.QueueUrl;
  }
}

/** Códigos de erro do SQS/AWS que significam "tente de novo mais tarde" (throttling, indisponibilidade). */
const TRANSIENT_SQS_ERROR_NAMES = new Set([
  'ServiceUnavailable',
  'InternalError',
  'InternalFailure',
  'RequestThrottled',
  'ThrottlingException',
  'Throttling',
  'KmsThrottled',
  'RequestTimeout',
  'RequestTimeoutException',
  'TimeoutError',
  'AbortError',
]);

/** Erros de rede do Node/Bun (SQS inalcançável). */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ConnectionRefused',
  'ConnectionClosed',
]);

/**
 * Classifica uma falha do SQS: `true` = transitória (rede, timeout, throttling, 5xx) — reenviar depois é
 * seguro; `false` = permanente (fila inexistente, parâmetro inválido, credencial). O publisher da outbox
 * reagenda nos dois casos (nunca descarta evento); a classificação vai para o log e, na F12, decide entre
 * reentrega e DLQ no consumidor.
 */
export function isTransientSqsError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const record = error as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
    $retryable?: unknown;
  };
  if (record.$retryable !== undefined && record.$retryable !== null) {
    return true;
  }
  if (typeof record.name === 'string' && TRANSIENT_SQS_ERROR_NAMES.has(record.name)) {
    return true;
  }
  if (typeof record.code === 'string' && TRANSIENT_NETWORK_CODES.has(record.code)) {
    return true;
  }
  const status = record.$metadata?.httpStatusCode;
  if (typeof status === 'number') {
    return status >= 500 || status === 429;
  }
  // Sem resposta HTTP nenhuma (falha de conexão sem código conhecido) também é transitória.
  return (
    record.$metadata === undefined &&
    typeof record.name === 'string' &&
    /network|socket|fetch|connect/i.test(`${record.name} ${String((error as Error).message)}`)
  );
}
