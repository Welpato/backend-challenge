import { FailureCode, failureCodeMetadata, isFailureCode } from '@/shared/failure-code';
import { newUuidV7 } from '@/shared/ids';
import { Money } from '@/shared/money/money';
import { computePayloadHash } from '@/wagering/domain/payload-hash';
import { WagerTransactionKind } from '@/wagering/domain/transaction-kind';
import { canTransition, isTerminalStatus, WagerTransactionStatus } from '@/wagering/domain/transaction-status';
import type {
  CreateOpeningTransactionProps,
  CreateWagerTransactionProps,
  WagerTransactionState,
} from '@/wagering/domain/wager-transaction.state';
import { assertValidTransactionInput } from '@/wagering/domain/wager-transaction.validation';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '@/wagering/domain/wagering.errors';
import { LedgerDirection } from '@/wallet/domain/ledger-direction';

/** Provider e prefixo das transações internas de abertura (ESPECIFICACAO.md §5, `CreateWallet`). */
export const INTERNAL_PROVIDER_ID = 'internal';
const OPENING_PREFIX = 'opening:';

/**
 * Transação de aposta com máquina de estados explícita (ESPECIFICACAO.md §3.3).
 *
 * Campos de negócio são `readonly`; só status, referência interna, código de falha, snapshot de saldo
 * e agendamento de referência mudam, e apenas pelas transições, que consultam a tabela
 * `WAGER_TRANSACTION_TRANSITIONS` por um único `assertCanTransition`. Toda transição valida os
 * argumentos **antes** de mudar qualquer campo: uma chamada que lança não deixa estado parcial.
 *
 * `payloadHash` é calculado na criação a partir dos campos de §6 — não é aceito de fora, então a
 * transação nunca carrega um hash que não corresponda ao próprio payload.
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    /** Id da referência no provedor — não o id interno. */
    readonly referenceExternalTransactionId: string | undefined,
    readonly correlationId: string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _balanceAfter: Money | undefined,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
  ) {}

  /**
   * Operação de provedor; nasce `PENDING`. Regras (códigos de contrato, viram 400/DLQ):
   * - `OPENING` → `KIND_NOT_ALLOWED` (só via `createOpening`);
   * - campos de texto obrigatórios não vazios, `kind` conhecido, data válida → `VALIDATION_ERROR`;
   * - REFUND/ROLLBACK exigem `referenceExternalTransactionId`; uma transação não referencia a si mesma;
   * - BET/WIN/REFUND/ROLLBACK exigem `money > 0`; LOSS aceita `money >= 0`.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(FailureCode.KIND_NOT_ALLOWED, 'OPENING transactions cannot be submitted');
    }
    assertValidTransactionInput(props);
    return WagerTransaction.newTransaction(props, WagerTransactionStatus.Pending);
  }

  /**
   * Crédito de abertura da wallet (interno): provider `internal`, key/external id `opening:{walletId}`,
   * já sai `PROCESSED` com `balanceAfter = money`.
   */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    const key = `${OPENING_PREFIX}${props.walletId}`;
    const input: CreateWagerTransactionProps = {
      ...(props.id === undefined ? {} : { id: props.id }),
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: key,
      idempotencyKey: key,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: key,
      gameId: INTERNAL_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      correlationId: props.correlationId,
      at: props.at,
    };
    assertValidTransactionInput(input);
    const opening = WagerTransaction.newTransaction(input, WagerTransactionStatus.Processed);
    opening._processedAt = WagerTransaction.copy(props.at);
    opening._balanceAfter = props.money;
    return opening;
  }

  /** Reconstrução a partir da persistência — não revalida regras nem transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      WagerTransaction.copy(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      WagerTransaction.copyOptional(state.processedAt),
      state.balanceAfter,
      state.attempts,
      WagerTransaction.copyOptional(state.nextAttemptAt),
    );
  }

  get createdAt(): Date {
    return WagerTransaction.copy(this._createdAt);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return WagerTransaction.copyOptional(this._processedAt);
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return WagerTransaction.copyOptional(this._nextAttemptAt);
  }

  // ---- transições

  /**
   * `PENDING | PENDING_REFERENCE → PROCESSED`. `balanceAfter` é o saldo da wallet depois da
   * aplicação (mesma moeda da transação, ≥ 0). `referenceTransactionId` (id interno) é obrigatório
   * exatamente quando a transação tem `referenceExternalTransactionId`.
   */
  markProcessed(referenceTransactionId: string | undefined, balanceAfter: Money, at: Date): void {
    this.assertCanTransition(WagerTransactionStatus.Processed);
    WagerTransaction.assertValidDate(at, 'processedAt');
    this.assertValidSnapshot(balanceAfter, true);
    const hasReference = this.referenceExternalTransactionId !== undefined;
    if (hasReference !== (referenceTransactionId !== undefined && referenceTransactionId.length > 0)) {
      throw WagerTransaction.misuse(
        hasReference
          ? 'A transaction with a reference must be processed with the internal reference id'
          : 'A transaction without a reference cannot be processed with a reference id',
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this._processedAt = WagerTransaction.copy(at);
    this._nextAttemptAt = undefined;
  }

  /** `PENDING → PENDING_REFERENCE` (primeira vez que a referência não é encontrada / não está pronta). */
  markPendingReference(nextAttemptAt: Date): void {
    this.assertCanTransition(WagerTransactionStatus.PendingReference);
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        this._status,
        WagerTransactionStatus.PendingReference,
        'already pending; use scheduleNextReferenceAttempt',
      );
    }
    if (this.referenceExternalTransactionId === undefined) {
      throw WagerTransaction.misuse('Only a transaction with a reference can wait for it');
    }
    WagerTransaction.assertValidDate(nextAttemptAt, 'nextAttemptAt');
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = WagerTransaction.copy(nextAttemptAt);
  }

  /** `PENDING_REFERENCE → PENDING_REFERENCE`: nova tentativa agendada; incrementa `attempts`. */
  scheduleNextReferenceAttempt(nextAttemptAt: Date): void {
    this.assertCanTransition(WagerTransactionStatus.PendingReference);
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        this._status,
        WagerTransactionStatus.PendingReference,
        'not pending a reference yet; use markPendingReference',
      );
    }
    WagerTransaction.assertValidDate(nextAttemptAt, 'nextAttemptAt');
    this._attempts += 1;
    this._nextAttemptAt = WagerTransaction.copy(nextAttemptAt);
  }

  /**
   * `→ REJECTED` com um código de negócio (`failureCodeMetadata(code).persisted === 'REJECTED'`).
   * `balanceAfter` é o saldo observado (inalterado) — devolvido nos replays — e é guardado na moeda
   * da wallet, que difere da transação quando a rejeição é justamente `CURRENCY_MISMATCH`.
   */
  reject(code: FailureCode, balanceAfter: Money, at: Date): void {
    this.assertCanTransition(WagerTransactionStatus.Rejected);
    WagerTransaction.assertFailureCode(code, 'REJECTED');
    WagerTransaction.assertValidDate(at, 'processedAt');
    this.assertValidSnapshot(balanceAfter, false);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceAfter;
    this._processedAt = WagerTransaction.copy(at);
    this._nextAttemptAt = undefined;
  }

  /** `→ FAILED` com código de infraestrutura permanente (`persisted === 'FAILED'`, hoje só `PROCESSING_FAILED`). */
  fail(code: FailureCode, at: Date): void {
    this.assertCanTransition(WagerTransactionStatus.Failed);
    WagerTransaction.assertFailureCode(code, 'FAILED');
    WagerTransaction.assertValidDate(at, 'processedAt');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = WagerTransaction.copy(at);
    this._nextAttemptAt = undefined;
  }

  // ---- consultas

  isTerminal(): boolean {
    return isTerminalStatus(this._status);
  }

  /** LOSS registra o resultado sem mover saldo; todos os outros kinds geram um lançamento. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** REFUND e ROLLBACK exigem referência (WIN pode ter, mas não exige). */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** Mesmo payload de negócio? Diferente com a mesma key/external id = conflito, não replay. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Sentido do lançamento desta transação: BET → DEBIT; OPENING/WIN/REFUND → CREDIT;
   * ROLLBACK → inverso do sentido da referência (BET → CREDIT; WIN/REFUND → DEBIT), que precisa ser
   * informada e ser a transação referenciada. LOSS não tem lançamento (erro de programação).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw WagerTransaction.misuse('LOSS does not produce a ledger entry');
      case WagerTransactionKind.Rollback:
        return this.rollbackDirection(reference);
    }
  }

  private rollbackDirection(reference: WagerTransaction | undefined): LedgerDirection {
    if (
      reference === undefined ||
      reference.providerId !== this.providerId ||
      reference.externalTransactionId !== this.referenceExternalTransactionId
    ) {
      throw WagerTransaction.misuse('ROLLBACK direction requires its referenced transaction');
    }
    if (
      reference.kind !== WagerTransactionKind.Bet &&
      reference.kind !== WagerTransactionKind.Win &&
      reference.kind !== WagerTransactionKind.Refund
    ) {
      throw WagerTransaction.misuse(`ROLLBACK cannot reverse a ${reference.kind}`);
    }
    return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
  }

  // ---- internos

  /** Única porta de checagem da tabela de transições. Estado terminal nunca muda. */
  private assertCanTransition(to: WagerTransactionStatus): void {
    if (!canTransition(this._status, to)) {
      throw new InvalidTransactionStateError(this._status, to);
    }
  }

  private assertValidSnapshot(balanceAfter: Money, sameCurrency: boolean): void {
    if (!(balanceAfter instanceof Money) || balanceAfter.isNegative()) {
      throw WagerTransaction.misuse('balanceAfter must be a non-negative Money');
    }
    if (sameCurrency && balanceAfter.currency !== this.money.currency) {
      throw WagerTransaction.misuse('balanceAfter must be in the transaction currency');
    }
  }

  private static newTransaction(props: CreateWagerTransactionProps, status: WagerTransactionStatus): WagerTransaction {
    return new WagerTransaction(
      props.id ?? newUuidV7(),
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      computePayloadHash(props),
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.correlationId,
      WagerTransaction.copy(props.at),
      status,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  private static assertFailureCode(code: FailureCode, persisted: 'REJECTED' | 'FAILED'): void {
    if (!isFailureCode(code) || failureCodeMetadata(code).persisted !== persisted) {
      throw WagerTransaction.misuse(`Failure code is not persisted as ${persisted}`);
    }
  }

  private static assertValidDate(date: Date, field: string): void {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw WagerTransaction.misuse(`${field} must be a valid date`);
    }
  }

  private static misuse(message: string): InvalidWagerTransactionError {
    return new InvalidWagerTransactionError('INVALID_WAGER_OPERATION', message);
  }

  private static copy(date: Date): Date {
    return new Date(date.getTime());
  }

  private static copyOptional(date: Date | undefined): Date | undefined {
    return date === undefined ? undefined : new Date(date.getTime());
  }
}
