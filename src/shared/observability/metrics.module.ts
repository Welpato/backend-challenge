import { Module } from '@nestjs/common';
import { collectDefaultMetrics, Registry } from 'prom-client';
import { APP_CONFIG, type AppConfig } from '@/config/app-config';
import { AppMetrics } from './app-metrics';
import { MetricsController } from './metrics.controller';

/**
 * Registry próprio (não o global do prom-client) para que testes possam subir várias instâncias da aplicação no
 * mesmo processo. Labels default em toda série: `instance` (o `INSTANCE_ID`) e `role`. Métricas do processo
 * (`collectDefaultMetrics`) + o catálogo de negócio/mensageria (`AppMetrics`, F14).
 */
function createRegistry(config: AppConfig): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ instance: config.instanceId, role: config.role });
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
    {
      provide: AppMetrics,
      useFactory: (registry: Registry) => new AppMetrics(registry),
      inject: [Registry],
    },
  ],
  exports: [Registry, AppMetrics],
})
export class MetricsModule {}
