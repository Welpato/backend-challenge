import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from '@/app.module';
import type { AppConfig } from '@/config/app-config';
import { correlationMiddleware } from '@/shared/observability/correlation';

/**
 * Monta a aplicação Nest para o papel configurado (sem chamar `listen`).
 * Compartilhado entre `main.ts` e os testes de integração, que sobem a app real.
 */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRole(config), { bufferLogs: true });
  app.disable('x-powered-by');
  app.useLogger(app.get(Logger));
  // Registrado antes dos middlewares dos módulos: o correlationId já existe quando o pino-http loga.
  app.use(correlationMiddleware);
  app.enableShutdownHooks();
  return app;
}
