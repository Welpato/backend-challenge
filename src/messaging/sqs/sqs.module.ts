import { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@/config/app-config';
import { createSqsClient, SqsQueueUrls } from './sqs.client';

@Global()
@Module({
  providers: [
    {
      provide: SQSClient,
      useFactory: (config: AppConfig) => createSqsClient(config),
      inject: [APP_CONFIG],
    },
    {
      provide: SqsQueueUrls,
      useFactory: (client: SQSClient) => new SqsQueueUrls(client),
      inject: [SQSClient],
    },
  ],
  exports: [SQSClient, SqsQueueUrls],
})
export class SqsModule implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
