import { Counter, Gauge, Histogram, type Registry } from 'prom-client';

/** Acima disso uma mensagem da outbox entra no alerta (`outbox_messages_over_retry_threshold`). Nunca é descartada. */
export const OUTBOX_RETRY_ALERT_ATTEMPTS = 10;

/** Faixas de latência (segundos): de 1 ms (replay) a 10 s (lock timeout + retentativa). */
const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export type WalletLockConflictType = 'timeout' | 'deadlock' | 'version';

/**
 * Catálogo único das métricas de negócio e de mensageria (ESPECIFICACAO.md §10, DESAFIO.md §12). Uma instância
 * por processo, registrada no `Registry` do `MetricsModule` (labels default `role` e `instance`). Quem mede só
 * chama os métodos tipados; nomes, labels e buckets ficam aqui — `docs/observabilidade.md` descreve cada uma.
 *
 * Gauges que dependem do banco (`outbox_*`, `pending_references`) **não** consultam o PostgreSQL no scrape: são
 * atualizados por coleta periódica (`DbGaugeCollector`).
 */
export class AppMetrics {
  readonly wagerTransactions: Counter<'kind' | 'status' | 'failure_code' | 'source'>;
  readonly idempotentReplays: Counter<'source'>;
  readonly inboxDuplicates: Counter;
  readonly sqsRetries: Counter;
  readonly sqsDlqMessages: Counter<'reason'>;
  readonly walletLockConflicts: Counter<'type'>;
  readonly walletLockWait: Histogram;
  readonly processingDuration: Histogram<'source' | 'kind'>;
  readonly outboxLag: Gauge;
  readonly outboxPending: Gauge;
  readonly outboxOverRetryThreshold: Gauge;
  readonly outboxPublished: Counter;
  readonly outboxPublishFailures: Counter;
  readonly pendingReferences: Gauge;
  readonly reconciliationMismatches: Counter;

  constructor(registry: Registry) {
    const registers = [registry];
    this.wagerTransactions = new Counter({
      name: 'wager_transactions_total',
      help: 'Wager transactions finalized by this instance (replays excluded), by kind, status, failure code and source',
      labelNames: ['kind', 'status', 'failure_code', 'source'],
      registers,
    });
    this.idempotentReplays = new Counter({
      name: 'idempotent_replays_total',
      help: 'Requests answered with the stored result of an earlier operation (same idempotency key or external id)',
      labelNames: ['source'],
      registers,
    });
    this.inboxDuplicates = new Counter({
      name: 'inbox_duplicates_total',
      help: 'SQS messages already processed (inbox hit), acknowledged without effect',
      registers,
    });
    this.sqsRetries = new Counter({
      name: 'sqs_retries_total',
      help: 'SQS messages returned for a later retry after a transient failure',
      registers,
    });
    this.sqsDlqMessages = new Counter({
      name: 'sqs_dlq_messages_total',
      help: 'SQS messages sent to the DLQ by the consumer after a permanent failure',
      labelNames: ['reason'],
      registers,
    });
    this.walletLockConflicts = new Counter({
      name: 'wallet_lock_conflicts_total',
      help: 'Wallet lock conflicts: lock timeout, deadlock or optimistic version guard',
      labelNames: ['type'],
      registers,
    });
    this.walletLockWait = new Histogram({
      name: 'wallet_lock_wait_seconds',
      help: 'Time between requesting and obtaining the wallet row lock',
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.processingDuration = new Histogram({
      name: 'processing_duration_seconds',
      help: 'Duration of a wager transaction processing (whole use case, including retries)',
      labelNames: ['source', 'kind'],
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.outboxLag = new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Age in seconds of the oldest unpublished outbox message (periodic collection)',
      registers,
    });
    this.outboxPending = new Gauge({
      name: 'outbox_pending',
      help: 'Outbox messages not yet published (periodic collection)',
      registers,
    });
    this.outboxOverRetryThreshold = new Gauge({
      name: 'outbox_messages_over_retry_threshold',
      help: `Unpublished outbox messages with more than ${OUTBOX_RETRY_ALERT_ATTEMPTS} failed attempts (alert)`,
      registers,
    });
    this.outboxPublished = new Counter({
      name: 'outbox_published_total',
      help: 'Outbox messages published',
      registers,
    });
    this.outboxPublishFailures = new Counter({
      name: 'outbox_publish_failures_total',
      help: 'Failed outbox publication attempts (rescheduled, never dropped)',
      registers,
    });
    this.pendingReferences = new Gauge({
      name: 'pending_references',
      help: 'Wager transactions waiting for their reference (PENDING_REFERENCE, periodic collection)',
      registers,
    });
    this.reconciliationMismatches = new Counter({
      name: 'reconciliation_mismatches_total',
      help: 'Wallet reconciliations that found the stored balance or the ledger chain inconsistent',
      registers,
    });
  }
}
