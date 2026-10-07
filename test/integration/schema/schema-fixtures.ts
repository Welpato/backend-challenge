import { randomUUID } from 'node:crypto';
import type { SQL } from 'bun';

/**
 * Linhas válidas por padrão para os testes de schema (SQL direto, sem domínio). Cada teste
 * sobrescreve só a coluna que quer violar. Dinheiro sempre como string `NUMERIC(20,2)`.
 */
const NOW = new Date('2026-10-07T12:00:00.000Z');

export interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  balance_after_amount: string | null;
  balance_after_currency: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  correlation_id: string | null;
  created_at: Date;
  processed_at: Date | null;
  updated_at: Date;
}

export interface LedgerEntryRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  wallet_version: number;
  created_at: Date;
}

export function walletRow(overrides: Partial<WalletRow> = {}): WalletRow {
  return {
    id: randomUUID(),
    player_id: `player-${randomUUID()}`,
    currency: 'BRL',
    balance: '0.00',
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function transactionRow(wallet: WalletRow, overrides: Partial<TransactionRow> = {}): TransactionRow {
  const externalId = `ext-${randomUUID()}`;
  return {
    id: randomUUID(),
    provider_id: 'provider-a',
    external_transaction_id: externalId,
    idempotency_key: `key-${externalId}`,
    payload_hash: 'a'.repeat(64),
    wallet_id: wallet.id,
    player_id: wallet.player_id,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: wallet.currency,
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: 'PENDING',
    failure_code: null,
    balance_after_amount: null,
    balance_after_currency: null,
    attempts: 0,
    next_attempt_at: null,
    correlation_id: 'corr-1',
    created_at: NOW,
    processed_at: null,
    updated_at: NOW,
    ...overrides,
  };
}

/** Transação finalizada como PROCESSED (com snapshot de saldo na moeda da wallet). */
export function processedRow(wallet: WalletRow, overrides: Partial<TransactionRow> = {}): TransactionRow {
  return transactionRow(wallet, {
    status: 'PROCESSED',
    balance_after_amount: wallet.balance,
    balance_after_currency: wallet.currency,
    processed_at: NOW,
    ...overrides,
  });
}

export function ledgerEntryRow(
  wallet: WalletRow,
  transaction: TransactionRow,
  overrides: Partial<LedgerEntryRow> = {},
): LedgerEntryRow {
  return {
    id: randomUUID(),
    wallet_id: wallet.id,
    transaction_id: transaction.id,
    direction: 'CREDIT',
    amount: transaction.amount,
    currency: wallet.currency,
    balance_before: '0.00',
    balance_after: transaction.amount,
    wallet_version: 1,
    created_at: NOW,
    ...overrides,
  };
}

export async function insertWallet(sql: SQL, row: WalletRow): Promise<WalletRow> {
  await sql`insert into wallets ${sql(row)}`;
  return row;
}

export async function insertTransaction(sql: SQL, row: TransactionRow): Promise<TransactionRow> {
  await sql`insert into wager_transactions ${sql(row)}`;
  return row;
}

export async function insertLedgerEntry(sql: SQL, row: LedgerEntryRow): Promise<LedgerEntryRow> {
  await sql`insert into wallet_ledger_entries ${sql(row)}`;
  return row;
}

/**
 * Cenário completo e consistente: wallet aberta com `amount` via OPENING PROCESSED + CREDIT
 * `0 → amount` (versão 1), numa única transação SQL (a checagem diferida roda no COMMIT).
 */
export async function insertFundedWallet(
  sql: SQL,
  amount = '100.00',
): Promise<{ wallet: WalletRow; opening: TransactionRow; entry: LedgerEntryRow }> {
  const wallet = walletRow({ balance: amount });
  const opening = processedRow(wallet, {
    kind: 'OPENING',
    amount,
    provider_id: 'internal',
    external_transaction_id: `opening:${wallet.id}`,
    idempotency_key: `opening:${wallet.id}`,
    round_id: `opening:${wallet.id}`,
    game_id: 'internal',
  });
  const entry = ledgerEntryRow(wallet, opening, { balance_before: '0.00', balance_after: amount });
  await sql.begin(async (tx) => {
    await insertWallet(tx, wallet);
    await insertTransaction(tx, opening);
    await insertLedgerEntry(tx, entry);
  });
  return { wallet, opening, entry };
}
