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
    /** Conexão da aplicação (role `app`, só DML). */
    readonly url: string;
    /** Conexão das migrations (role `migrator`, DDL); `undefined` = usar `url`. Só o `scripts/migrate.ts` lê. */
    readonly migrationUrl: string | undefined;
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
    /** Limite de mensagens em processamento simultâneo por instância do consumidor (F12). */
    readonly consumerMaxInFlight: number;
    /** Backoff do consumidor (F12) para falhas transitórias, via `ChangeMessageVisibility`. */
    readonly retryBackoffBaseMs: number;
    readonly retryBackoffMaxMs: number;
  };
  readonly metrics: {
    /** Intervalo da coleta periódica dos gauges de banco (`outbox_*`, `pending_references`). */
    readonly collectIntervalMs: number;
  };
  readonly timeouts: {
    readonly healthCheckMs: number;
    readonly shutdownGraceMs: number;
  };
  readonly outbox: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
  };
  readonly reprocessor: {
    readonly intervalMs: number;
    readonly batchSize: number;
    /** Por quanto tempo uma pendência reivindicada fica fora do alcance de outras instâncias. */
    readonly leaseMs: number;
    readonly pendingReferenceTtlMs: number;
    readonly pendingReferenceMaxAttempts: number;
    readonly pendingReferenceBackoffBaseMs: number;
    readonly pendingReferenceBackoffMaxMs: number;
  };
  /** Injeção de falhas — usada apenas pelos testes de recuperação. */
  readonly faults: {
    readonly exitAfterCommit: boolean;
    readonly exitAfterPublish: boolean;
  };
}
