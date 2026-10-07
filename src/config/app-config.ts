import type { AppRole } from './env.schema';

/** Token de injeção da configuração validada (`@Inject(APP_CONFIG)`). */
export const APP_CONFIG = Symbol('APP_CONFIG');

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface AppConfig {
  readonly role: AppRole;
  readonly port: number;
  /** Identifica a réplica nos logs; no Compose é o hostname do container. */
  readonly instanceId: string;
  readonly logLevel: LogLevel;
  readonly database: {
    readonly url: string;
    readonly lockTimeoutMs: number;
  };
  readonly sqs: {
    /** Ausente = endpoint padrão da AWS. Em desenvolvimento aponta para o LocalStack. */
    readonly endpoint: string | undefined;
    readonly region: string;
    readonly queues: {
      readonly wagerTransactions: string;
      readonly wagerTransactionsDlq: string;
      readonly walletEvents: string;
    };
    readonly waitTimeSeconds: number;
    readonly visibilityTimeoutSeconds: number;
    readonly maxReceiveCount: number;
  };
  readonly timeouts: {
    readonly healthCheckMs: number;
    readonly shutdownGraceMs: number;
  };
  readonly outbox: {
    readonly pollIntervalMs: number;
  };
  readonly reprocessor: {
    readonly intervalMs: number;
    readonly pendingReferenceTtlMs: number;
    readonly pendingReferenceMaxAttempts: number;
  };
  /** Injeção de falhas — usada apenas pelos testes de recuperação. */
  readonly faults: {
    readonly exitAfterCommit: boolean;
  };
}
