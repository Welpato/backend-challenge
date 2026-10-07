import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appDb, closeDb, expectPgError, migratorDb, PgError, truncateAll } from '../../support/db';

const NOW = new Date('2026-10-07T12:00:00.000Z');

async function insertOutbox(): Promise<string> {
  const id = randomUUID();
  const row = {
    id,
    aggregate_id: randomUUID(),
    event_type: 'WalletBalanceChanged',
    event_version: 1,
    payload: { eventId: id, data: { balanceAfter: { amount: '10.00', currency: 'BRL' } } },
    correlation_id: 'corr-1',
    occurred_at: NOW,
    next_attempt_at: NOW,
  };
  await appDb()`insert into outbox_messages ${appDb()(row)}`;
  return id;
}

async function insertInbox(): Promise<{ consumer: string; messageId: string }> {
  const row = {
    consumer_name: 'wager-transactions',
    message_id: randomUUID(),
    payload_hash: 'c'.repeat(64),
    received_at: NOW,
  };
  await appDb()`insert into inbox_messages ${appDb()(row)}`;
  return { consumer: row.consumer_name, messageId: row.message_id };
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe('outbox_messages schema', () => {
  it('allows the publication state to change', async () => {
    const id = await insertOutbox();

    await appDb()`update outbox_messages
      set attempts = attempts + 1, next_attempt_at = now(), last_error = 'timeout' where id = ${id}`;
    await appDb()`update outbox_messages set published_at = now() where id = ${id}`;

    const rows: { attempts: number; published: boolean }[] =
      await appDb()`select attempts, published_at is not null as published from outbox_messages where id = ${id}`;
    expect(rows).toEqual([{ attempts: 1, published: true }]);
  });

  it.each([
    ['payload', { other: true }],
    ['event_type', 'WagerTransactionProcessed'],
    ['aggregate_id', 'other-wallet'],
    ['event_version', 2],
    ['correlation_id', 'other-corr'],
    ['occurred_at', new Date('2026-10-08T00:00:00.000Z')],
  ])('rejects changing %s', async (column, value) => {
    const id = await insertOutbox();

    await expectPgError(
      appDb()`update outbox_messages set ${appDb()({ [column]: value })} where id = ${id}`,
      PgError.raiseException,
      new RegExp(`immutable columns .*: ${column}$`),
    );
  });

  it('rejects a duplicate event id and denies DELETE to the app role', async () => {
    const id = await insertOutbox();

    await expectPgError(
      appDb()`insert into outbox_messages (id, aggregate_id, event_type, event_version, payload, occurred_at, next_attempt_at)
        values (${id}, 'w', 'X', 1, '{}'::jsonb, now(), now())`,
      PgError.uniqueViolation,
    );
    await expectPgError(appDb()`delete from outbox_messages where id = ${id}`, PgError.insufficientPrivilege);
  });
});

describe('inbox_messages schema', () => {
  it('rejects a duplicate (consumer_name, message_id)', async () => {
    const { consumer, messageId } = await insertInbox();

    await expectPgError(
      appDb()`insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
        values (${consumer}, ${messageId}, ${'d'.repeat(64)}, now())`,
      PgError.uniqueViolation,
    );
  });

  it('blocks DELETE (trigger for the owner, permission for the app role)', async () => {
    const { consumer, messageId } = await insertInbox();

    await expectPgError(
      migratorDb()`delete from inbox_messages where consumer_name = ${consumer} and message_id = ${messageId}`,
      PgError.raiseException,
      /cannot be deleted/,
    );
    await expectPgError(
      appDb()`delete from inbox_messages where consumer_name = ${consumer} and message_id = ${messageId}`,
      PgError.insufficientPrivilege,
    );
  });

  it('allows marking a message as processed', async () => {
    const { consumer, messageId } = await insertInbox();

    await appDb()`update inbox_messages set processed_at = now()
      where consumer_name = ${consumer} and message_id = ${messageId}`;
  });
});
