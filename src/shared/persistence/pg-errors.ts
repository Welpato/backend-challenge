/**
 * Classificação dos erros do PostgreSQL para a aplicação.
 *
 * O MikroORM embrulha o erro do driver `pg` (`DriverException` e subclasses), mas copia as propriedades
 * do original — `code` (SQLSTATE) e `constraint` continuam disponíveis. Mesmo assim o classificador também
 * olha a cadeia `cause`, para funcionar com o erro cru do driver.
 *
 * SQLSTATEs (ver também `migrations/0001_init.ts`):
 * - `23505` unique_violation → `UniqueViolationError` com o nome da constraint/índice
 *   (`uq_wager_transactions_idempotency_key`, `uq_wager_transactions_provider_external`, `ux_reversal_once`…);
 * - `23514` check_violation → `CheckViolationError` (CHECKs e a consistência diferida wallet ↔ ledger, que só
 *   dispara no COMMIT e indica bug de programação, não regra de negócio);
 * - `40001` serialization, `40P01` deadlock, `55P03` lock timeout, `57P01`/`57P02`/`57P03` (servidor
 *   derrubando/encerrando conexões), classe `08` (conexão) e erros de socket → `TransientDatabaseError`.
 */
export const PgSqlState = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  lockNotAvailable: '55P03',
  adminShutdown: '57P01',
  crashShutdown: '57P02',
  cannotConnectNow: '57P03',
} as const;

export type TransientDatabaseReason = 'serialization' | 'deadlock' | 'lock_timeout' | 'connection';

/** Falha passageira do banco: a operação inteira pode ser repetida com a mesma idempotency key. */
export class TransientDatabaseError extends Error {
  readonly sqlState: string | undefined;

  constructor(
    readonly reason: TransientDatabaseReason,
    options: { sqlState?: string | undefined; cause: unknown },
  ) {
    super(`Transient database failure (${reason})`, { cause: options.cause });
    this.name = 'TransientDatabaseError';
    this.sqlState = options.sqlState;
  }
}

export class UniqueViolationError extends Error {
  constructor(
    readonly constraint: string | undefined,
    options: { cause: unknown },
  ) {
    super(`Unique constraint violated: ${constraint ?? 'unknown'}`, { cause: options.cause });
    this.name = 'UniqueViolationError';
  }
}

export class CheckViolationError extends Error {
  constructor(
    readonly constraint: string | undefined,
    options: { cause: unknown },
  ) {
    super(`Check constraint violated: ${constraint ?? 'unknown'}`, { cause: options.cause });
    this.name = 'CheckViolationError';
  }
}

export type ClassifiedDatabaseError = TransientDatabaseError | UniqueViolationError | CheckViolationError;

/** Erros de socket/DNS do Node que significam "o banco não está alcançável agora". */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/** Mensagens do `pg`/`pg-pool` sem código quando a conexão cai ou o pool não consegue conectar. */
const CONNECTION_ERROR_MESSAGES = [
  /connection terminated/i,
  /terminating connection/i,
  /connection timeout/i,
  /timeout exceeded when trying to connect/i,
  /client has encountered a connection error/i,
  /cannot use a pool after calling end/i,
];

interface ErrorFields {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly message: string;
}

function fieldsOf(error: unknown): ErrorFields | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    constraint: typeof record.constraint === 'string' ? record.constraint : undefined,
    message: typeof record.message === 'string' ? record.message : '',
  };
}

function classifyOne(error: unknown): ClassifiedDatabaseError | undefined {
  const fields = fieldsOf(error);
  if (fields === undefined) {
    return undefined;
  }
  const { code, constraint, message } = fields;
  switch (code) {
    case PgSqlState.uniqueViolation:
      return new UniqueViolationError(constraint, { cause: error });
    case PgSqlState.checkViolation:
      return new CheckViolationError(constraint, { cause: error });
    case PgSqlState.serializationFailure:
      return new TransientDatabaseError('serialization', { sqlState: code, cause: error });
    case PgSqlState.deadlockDetected:
      return new TransientDatabaseError('deadlock', { sqlState: code, cause: error });
    case PgSqlState.lockNotAvailable:
      return new TransientDatabaseError('lock_timeout', { sqlState: code, cause: error });
    case PgSqlState.adminShutdown:
    case PgSqlState.crashShutdown:
    case PgSqlState.cannotConnectNow:
      return new TransientDatabaseError('connection', { sqlState: code, cause: error });
  }
  if (code !== undefined && /^08[0-9A-Z]{3}$/.test(code)) {
    return new TransientDatabaseError('connection', { sqlState: code, cause: error });
  }
  if (
    (code !== undefined && CONNECTION_ERROR_CODES.has(code)) ||
    CONNECTION_ERROR_MESSAGES.some((re) => re.test(message))
  ) {
    return new TransientDatabaseError('connection', { cause: error });
  }
  return undefined;
}

/**
 * Classifica um erro vindo do banco. Percorre a cadeia `cause` (até 5 níveis) e devolve a primeira
 * classificação encontrada; `undefined` = erro não classificado (bug, permissão, sintaxe…), que deve
 * subir como está. Um erro já classificado é devolvido sem alteração.
 */
export function classifyPgError(error: unknown): ClassifiedDatabaseError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (
      current instanceof TransientDatabaseError ||
      current instanceof UniqueViolationError ||
      current instanceof CheckViolationError
    ) {
      return current;
    }
    const classified = classifyOne(current);
    if (classified !== undefined) {
      return classified;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isTransientDatabaseError(error: unknown): boolean {
  return classifyPgError(error) instanceof TransientDatabaseError;
}

/** `true` se o erro é violação de unicidade da constraint/índice informado. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const classified = classifyPgError(error);
  return (
    classified instanceof UniqueViolationError && (constraint === undefined || classified.constraint === constraint)
  );
}

/**
 * `true` se o erro (ou alguém na cadeia `cause`) é violação de FK (`23503`) da constraint informada.
 * Não vira classe própria: o único uso é o INSERT de `wager_transactions` com wallet inexistente
 * (`wager_transactions_wallet_id_fkey` → `WALLET_NOT_FOUND`, F09); fora disso continua sendo bug (500).
 */
export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const fields = fieldsOf(current);
    if (fields?.code === PgSqlState.foreignKeyViolation) {
      return constraint === undefined || fields.constraint === constraint;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
