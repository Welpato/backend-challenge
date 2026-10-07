import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@/config/app-config';
import { SqsQueueUrls } from '@/messaging/sqs/sqs.client';
import type { HealthIndicator } from './health-indicator';

/** `GetQueueAttributes` na fila de entrada (`wager-transactions.fifo`). */
@Injectable()
export class SqsHealthIndicator implements HealthIndicator {
  readonly name = 'sqs';

  constructor(
    @Inject(SQSClient) private readonly client: SQSClient,
    @Inject(SqsQueueUrls) private readonly queueUrls: SqsQueueUrls,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async check(signal: AbortSignal): Promise<void> {
    const queueUrl = await this.queueUrls.resolve(this.config.sqs.queues.wagerTransactions, signal);
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }), {
      abortSignal: signal,
    });
  }
}
