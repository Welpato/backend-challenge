/**
 * Campos que nunca podem aparecer em log: valores monetários, saldos e corpos de requisição.
 *
 * O pino (fast-redact) não aceita curingas parciais como `*.balance*`, então as variações
 * conhecidas de saldo são listadas explicitamente e aplicadas em até três níveis de aninhamento.
 */
const SENSITIVE_KEYS = [
  'money',
  'amount',
  'balance',
  'balanceAfter',
  'balanceBefore',
  'balance_after',
  'balance_before',
  'balanceAfterAmount',
  'balance_after_amount',
  'initialBalance',
  'storedBalance',
  'calculatedBalance',
  'difference',
  'credits',
  'debits',
  // Payloads inteiros (evento, envelope SQS, corpo de mensagem) também nunca vão para o log.
  'payload',
  'data',
  'body',
  'Body',
  'MessageBody',
  // Erros do PostgreSQL/driver: `detail` traz a linha recusada ("Failing row contains (…, 25.00, …)") e os
  // parâmetros da consulta podem conter valores. Só aparecem em caminhos de erro, mas o log continua sem dinheiro.
  'detail',
  'params',
  'parameters',
] as const;

const NESTING_PREFIXES = ['', '*.', '*.*.'] as const;

const FIXED_PATHS = ['req.body', 'res.body', 'req.headers.authorization', 'req.headers.cookie'] as const;

export const LOG_REDACT_PATHS: readonly string[] = [
  ...FIXED_PATHS,
  ...NESTING_PREFIXES.flatMap((prefix) => SENSITIVE_KEYS.map((key) => `${prefix}${key}`)),
];

export const LOG_REDACT_CENSOR = '[REDACTED]';
