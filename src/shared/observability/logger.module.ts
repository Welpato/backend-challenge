import type { IncomingMessage, ServerResponse } from 'node:http';
import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { stdTimeFunctions } from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';
import type { AppConfig } from '@/config/app-config';
import { CORRELATION_HEADER, currentCorrelationId, resolveCorrelationId } from './correlation';
import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS } from './log-redaction';

/** Rotas operacionais (probes do Compose/Prometheus) só aparecem em `debug` quando dão certo. */
const OPERATIONAL_ROUTES = /^\/(health|metrics)(\/|$|\?)/;

type LogLevelName = 'error' | 'warn' | 'info' | 'debug';

function requestLogLevel(req: IncomingMessage, res: ServerResponse, error?: Error): LogLevelName {
  if (error !== undefined || res.statusCode >= 500) {
    return 'error';
  }
  if (res.statusCode >= 400) {
    return 'warn';
  }
  return OPERATIONAL_ROUTES.test(req.url ?? '') ? 'debug' : 'info';
}

/**
 * Opções do pino: JSON puro, `instanceId`/`role` em todas as linhas, `correlationId` vindo do
 * `AsyncLocalStorage` (via `mixin`) e redaction de valores monetários/saldos/corpos.
 */
export function buildLoggerOptions(config: AppConfig): PinoHttpOptions {
  return {
    level: config.logLevel,
    base: { instanceId: config.instanceId, role: config.role },
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
    mixin: () => {
      const correlationId = currentCorrelationId();
      return correlationId === undefined ? {} : { correlationId };
    },
    // O middleware de correlação já definiu o header de resposta; o id do pino-http é o mesmo valor.
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const fromResponse = res.getHeader(CORRELATION_HEADER);
      return typeof fromResponse === 'string' ? fromResponse : resolveCorrelationId(req.headers[CORRELATION_HEADER]);
    },
    customLogLevel: requestLogLevel,
  };
}

@Module({})
export class AppLoggerModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppLoggerModule,
      imports: [LoggerModule.forRoot({ pinoHttp: buildLoggerOptions(config) })],
      exports: [LoggerModule],
    };
  }
}
