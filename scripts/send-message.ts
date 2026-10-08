/**
 * Publica mensagens `WagerTransactionRequested` na `wager-transactions.fifo` (ou em outra fila) — utilitário de
 * teste manual do consumidor (F12). Usa a mesma configuração da app (`.env`: `SQS_ENDPOINT`, credenciais).
 *
 *   bun scripts/send-message.ts --wallet <walletId> --player <playerId>                 # BET de 25.00 BRL
 *   bun scripts/send-message.ts --wallet <id> --player <id> --kind WIN --amount 50.00 --external tx-2
 *   bun scripts/send-message.ts --wallet <id> --player <id> --message-id msg-1 --count 2   # mesma mensagem 2×
 *   bun scripts/send-message.ts --raw '{"messageId":"bad","type":"Nope"}' --group g1      # corpo arbitrário
 *
 * Opções: --provider (provider-a) --external (tx-<uuid>) --key ({provider}:{external}) --round (round-1)
 * --game (fortune-chimp) --kind (BET) --amount (25.00) --currency (BRL) --reference <externalId>
 * --message-id (msg-<uuid>) --count (1; repete a MESMA mensagem; da 2ª em diante com outro MessageDeduplicationId)
 * --correlation-id <id> --queue <nome> --group <MessageGroupId> (default: a wallet).
 *
 * Imprime o envelope enviado e o `MessageId` do SQS de cada envio.
 */
import { parseArgs } from 'node:util';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '@/config/load-config';
import { createSqsClient, SqsQueueUrls } from '@/messaging/sqs/sqs.client';

const { values } = parseArgs({
  options: {
    wallet: { type: 'string' },
    player: { type: 'string' },
    provider: { type: 'string', default: 'provider-a' },
    external: { type: 'string' },
    key: { type: 'string' },
    round: { type: 'string', default: 'round-1' },
    game: { type: 'string', default: 'fortune-chimp' },
    kind: { type: 'string', default: 'BET' },
    amount: { type: 'string', default: '25.00' },
    currency: { type: 'string', default: 'BRL' },
    reference: { type: 'string' },
    'message-id': { type: 'string' },
    'correlation-id': { type: 'string' },
    count: { type: 'string', default: '1' },
    queue: { type: 'string' },
    group: { type: 'string' },
    raw: { type: 'string' },
  },
  strict: true,
});

function buildBody(): { body: string; group: string; messageId: string | undefined } {
  if (values.raw !== undefined) {
    return { body: values.raw, group: values.group ?? 'manual', messageId: undefined };
  }
  if (values.wallet === undefined || values.player === undefined) {
    console.error('Usage: bun scripts/send-message.ts --wallet <walletId> --player <playerId> [options] (or --raw)');
    process.exit(2);
  }
  const externalTransactionId = values.external ?? `tx-${crypto.randomUUID()}`;
  const envelope = {
    messageId: values['message-id'] ?? `msg-${crypto.randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: values.provider,
      externalTransactionId,
      idempotencyKey: values.key ?? `${values.provider}:${externalTransactionId}`,
      playerId: values.player,
      walletId: values.wallet,
      roundId: values.round,
      gameId: values.game,
      kind: values.kind,
      money: { amount: values.amount, currency: values.currency },
      ...(values.reference === undefined ? {} : { referenceExternalTransactionId: values.reference }),
    },
  };
  return { body: JSON.stringify(envelope), group: values.group ?? values.wallet, messageId: envelope.messageId };
}

const config = loadConfig();
const client = createSqsClient(config);
const queueName = values.queue ?? config.sqs.queues.wagerTransactions;
const queueUrl = await new SqsQueueUrls(client).resolve(queueName);
const count = Number.parseInt(values.count, 10);
const { body, group, messageId } = buildBody();
console.log(body);
for (let i = 0; i < count; i += 1) {
  const output = await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: group,
      // 1º envio: dedup = messageId (como os produtores, §7). Repetições (--count) usam outro dedup id: simulam
      // a duplicata que o broker não descarta e a inbox deduplica.
      MessageDeduplicationId: i === 0 && messageId !== undefined ? messageId : crypto.randomUUID(),
      ...(values['correlation-id'] === undefined
        ? {}
        : { MessageAttributes: { correlationId: { DataType: 'String', StringValue: values['correlation-id'] } } }),
    }),
  );
  console.log(`sent to ${queueName}: SQS MessageId ${output.MessageId}`);
}
client.destroy();
