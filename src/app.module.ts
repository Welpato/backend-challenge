import { type DynamicModule, Module, type Type } from '@nestjs/common';
import type { AppConfig } from '@/config/app-config';
import { ConfigModule } from '@/config/config.module';
import type { AppRole } from '@/config/env.schema';
import { HealthModule } from '@/health/health.module';
import { SqsModule } from '@/messaging/sqs/sqs.module';
import { AppLoggerModule } from '@/shared/observability/logger.module';
import { MetricsModule } from '@/shared/observability/metrics.module';
import { DatabaseModule } from '@/shared/persistence/database.module';

/**
 * Módulos específicos de cada papel. Todos os papéis sobem HTTP com health + métricas;
 * os workers ficam ociosos até as fases que os implementam:
 * api → F08/F09 · consumer → F12 · outbox → F11 · reprocessor → F10.
 */
const ROLE_MODULES: Readonly<Record<Exclude<AppRole, 'all'>, readonly Type[]>> = {
  api: [],
  consumer: [],
  outbox: [],
  reprocessor: [],
};

function modulesFor(role: AppRole): Type[] {
  if (role === 'all') {
    return [...new Set(Object.values(ROLE_MODULES).flat())];
  }
  return [...ROLE_MODULES[role]];
}

@Module({})
export class AppModule {
  static forRole(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        AppLoggerModule.forRoot(config),
        DatabaseModule,
        SqsModule,
        MetricsModule,
        HealthModule,
        ...modulesFor(config.role),
      ],
    };
  }
}
