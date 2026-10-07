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
