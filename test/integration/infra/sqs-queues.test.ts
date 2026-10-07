import { afterAll, describe, expect, it } from 'bun:test';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '@/config/load-config';
import { createSqsClient, SqsQueueUrls } from '@/messaging/sqs/sqs.client';

// Verifica as filas criadas por docker/localstack-init.sh no SQS real da infra de teste.
const config = loadConfig();
const client = createSqsClient(config);
const queueUrls = new SqsQueueUrls(client);
const { wagerTransactions, wagerTransactionsDlq, walletEvents } = config.sqs.queues;
const MAX_RECEIVE_ATTEMPTS = 15;

async function attributesOf(queueName: string): Promise<Record<string, string>> {
  const output = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: await queueUrls.resolve(queueName), AttributeNames: ['All'] }),
  );
  return output.Attributes ?? {};
}

afterAll(() => {
  client.destroy();
});

describe('SQS queues (real LocalStack)', () => {
  it.each([wagerTransactions, wagerTransactionsDlq, walletEvents])(
    '%s is FIFO without content-based dedup',
    async (name) => {
      const attributes = await attributesOf(name);
      expect(attributes.FifoQueue).toBe('true');
      expect(attributes.ContentBasedDeduplication).toBe('false');
    },
  );

  it('wager queue has visibility 30s and redrives to the DLQ after 5 receives', async () => {
    const attributes = await attributesOf(wagerTransactions);
    const dlqArn = (await attributesOf(wagerTransactionsDlq)).QueueArn;
    const redrive = JSON.parse(attributes.RedrivePolicy ?? '{}') as {
      deadLetterTargetArn?: string;
      maxReceiveCount?: unknown;
    };

    expect(attributes.VisibilityTimeout).toBe('30');
    expect(redrive.deadLetterTargetArn).toBe(dlqArn);
    expect(Number(redrive.maxReceiveCount)).toBe(config.sqs.maxReceiveCount);
  });

  it('moves a FIFO message that is never acked to the FIFO DLQ', async () => {
    const queueUrl = await queueUrls.resolve(wagerTransactions);
    const dlqUrl = await queueUrls.resolve(wagerTransactionsDlq);
    const marker = `redrive-probe-${Bun.randomUUIDv7()}`;

    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: marker,
        MessageGroupId: marker,
        MessageDeduplicationId: marker,
      }),
    );

    let receives = 0;
    for (let attempt = 0; attempt < MAX_RECEIVE_ATTEMPTS; attempt += 1) {
      const output = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          VisibilityTimeout: 0,
          WaitTimeSeconds: 1,
        }),
      );
      const ours = (output.Messages ?? []).filter((message) => message.Body === marker);
      if (ours.length === 0 && receives >= config.sqs.maxReceiveCount) {
        break;
      }
      receives += ours.length;
    }
    expect(receives).toBe(config.sqs.maxReceiveCount);

    const fromDlq = await client.send(
      new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }),
    );
    const moved = (fromDlq.Messages ?? []).find((message) => message.Body === marker);
    expect(moved).toBeDefined();
    if (moved?.ReceiptHandle !== undefined) {
      await client.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: moved.ReceiptHandle }));
    }
  });
});
