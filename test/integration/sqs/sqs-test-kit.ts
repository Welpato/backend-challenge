import { appDb } from '../../support/db';
import { drainQueue, type IsolatedQueue, wagerEnvelope } from '../../support/sqs';
import { waitFor } from '../../support/subprocess';
import type { OpenedWallet, TransactionInput } from '../../support/wagering-http';

/** Helpers dos testes do consumidor SQS (F12). Tudo contra PG + SQS reais. */

export interface TransactionRow {
  readonly id: string;
  readonly status: string;
  readonly failure_code: string | null;
  readonly correlation_id: string | null;
}

/** `data` do envelope a partir da operação de teste (key padrão `{provider}:{external}`). */
export function envelopeFor(
  input: TransactionInput,
  options: { messageId?: string; idempotencyKey?: string } = {},
): Record<string, unknown> {
  return wagerEnvelope({
    ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
    data: {
      ...input,
      idempotencyKey: options.idempotencyKey ?? `${input.providerId}:${input.externalTransactionId}`,
    },
  });
}

export async function transactionsOf(walletId: string): Promise<TransactionRow[]> {
  return (await appDb()`
    select id, status, failure_code, correlation_id
      from wager_transactions
     where wallet_id = ${walletId} and kind <> 'OPENING'
     order by created_at, id`) as TransactionRow[];
}

/** Espera a transação `(provider, externalId)` existir em um dos status pedidos. */
export async function waitForStatus(
  input: Pick<TransactionInput, 'providerId' | 'externalTransactionId'>,
  statuses: readonly string[],
  timeoutMs = 15_000,
): Promise<TransactionRow> {
  let found: TransactionRow | undefined;
  await waitFor(
    async () => {
      const [row] = (await appDb()`
        select id, status, failure_code, correlation_id from wager_transactions
         where provider_id = ${input.providerId} and external_transaction_id = ${input.externalTransactionId}`) as TransactionRow[];
      found = row;
      return row !== undefined && statuses.includes(row.status);
    },
    timeoutMs,
    `transaction ${input.externalTransactionId} in ${statuses.join('|')}`,
  );
  return found as TransactionRow;
}

export async function inboxRows(): Promise<{ consumer_name: string; message_id: string; processed: boolean }[]> {
  return (await appDb()`
    select consumer_name, message_id, processed_at is not null as processed
      from inbox_messages order by received_at, message_id`) as {
    consumer_name: string;
    message_id: string;
    processed: boolean;
  }[];
}

export interface DlqEntry {
  readonly body: string;
  readonly failureReason: string | undefined;
  readonly originalMessageId: string | undefined;
  readonly groupId: string | undefined;
}

/** Lê (e apaga) tudo o que estiver na DLQ, esperando chegar pelo menos `expected` mensagens. */
export async function collectDlq(dlq: IsolatedQueue, expected: number, timeoutMs = 20_000): Promise<DlqEntry[]> {
  const collected: DlqEntry[] = [];
  await waitFor(
    async () => {
      for (const message of await drainQueue(dlq, 1)) {
        collected.push({
          body: message.Body ?? '',
          failureReason: message.MessageAttributes?.failureReason?.StringValue,
          originalMessageId: message.MessageAttributes?.originalMessageId?.StringValue,
          groupId: message.Attributes?.MessageGroupId,
        });
      }
      return collected.length >= expected;
    },
    timeoutMs,
    `${expected} message(s) in the DLQ`,
    200,
  );
  return collected;
}

export function walletIdsOf(...wallets: readonly OpenedWallet[]): string[] {
  return wallets.map((wallet) => wallet.walletId);
}
