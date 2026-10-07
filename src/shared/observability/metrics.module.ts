import { Module } from '@nestjs/common';
import { collectDefaultMetrics, Registry } from 'prom-client';
import { APP_CONFIG, type AppConfig } from '@/config/app-config';
import { MetricsController } from './metrics.controller';

/**
 * Registry próprio (não o global do prom-client) para que testes possam subir várias
 * instâncias da aplicação no mesmo processo. Por enquanto só métricas default do processo;
 * as métricas de negócio entram na F14.
 */
function createRegistry(config: AppConfig): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ role: config.role, instance_id: config.instanceId });
  collectDefaultMetrics({ register: registry });
  return registry;
}

@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: Registry,
      useFactory: (config: AppConfig) => createRegistry(config),
      inject: [APP_CONFIG],
    },
  ],
  exports: [Registry],
})
export class MetricsModule {}
