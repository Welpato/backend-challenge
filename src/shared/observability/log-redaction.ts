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
] as const;

const NESTING_PREFIXES = ['', '*.', '*.*.'] as const;

const FIXED_PATHS = [
  'req.body',
  'res.body',
  'body',
  'payload',
  'req.headers.authorization',
  'req.headers.cookie',
] as const;

export const LOG_REDACT_PATHS: readonly string[] = [
  ...FIXED_PATHS,
  ...NESTING_PREFIXES.flatMap((prefix) => SENSITIVE_KEYS.map((key) => `${prefix}${key}`)),
];

export const LOG_REDACT_CENSOR = '[REDACTED]';
