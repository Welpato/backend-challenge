import { DomainError } from '@/shared/errors/domain-error';
import { FailureCode } from '@/shared/failure-code';

/** Cursor do ledger malformado, adulterado ou de outro formato. Erro de contrato (400). */
export class InvalidLedgerCursorError extends DomainError {
  constructor() {
    super(FailureCode.VALIDATION_ERROR, 'Invalid ledger cursor');
  }
}

const BASE64URL = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Cursor opaco e estável do ledger: base64url (sem padding) de `{"v":<walletVersion>}` — a última versão já
 * entregue. A paginação é keyset em `wallet_version` (append-only e contígua), então o cursor continua válido
 * mesmo com lançamentos novos chegando entre as páginas.
 */
export function encodeLedgerCursor(walletVersion: number): string {
  if (!Number.isSafeInteger(walletVersion) || walletVersion < 1) {
    throw new RangeError('walletVersion must be a positive safe integer');
  }
  return Buffer.from(JSON.stringify({ v: walletVersion }), 'utf8').toString('base64url');
}

/**
 * Decodifica o cursor → `walletVersion`. Aceita só a forma canônica produzida por `encodeLedgerCursor`
 * (reencodar tem que devolver a mesma string); qualquer outra coisa → `InvalidLedgerCursorError`.
 */
export function decodeLedgerCursor(cursor: string): number {
  if (!BASE64URL.test(cursor)) {
    throw new InvalidLedgerCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidLedgerCursorError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidLedgerCursorError();
  }
  const keys = Object.keys(parsed);
  const version = (parsed as { v?: unknown }).v;
  if (keys.length !== 1 || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new InvalidLedgerCursorError();
  }
  if (encodeLedgerCursor(version) !== cursor) {
    throw new InvalidLedgerCursorError();
  }
  return version;
}
