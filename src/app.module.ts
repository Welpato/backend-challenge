import { type DynamicModule, Module, type Type } from '@nestjs/common';
import type { AppConfig } from '@/config/app-config';
import { ConfigModule } from '@/config/config.module';
import type { AppRole } from '@/config/env.schema';
import { HealthModule } from '@/health/health.module';
import { SqsModule } from '@/messaging/sqs/sqs.module';
import { PersistenceModule } from '@/persistence.module';
import { PERSISTENCE_RECORDS } from '@/persistence-records';
import { HttpCommonModule } from '@/shared/http/http.module';
import { AppLoggerModule } from '@/shared/observability/logger.module';
import { MetricsModule } from '@/shared/observability/metrics.module';
import { DatabaseModule } from '@/shared/persistence/database.module';
import { WalletModule } from '@/wallet/wallet.module';

/**
 * Módulos específicos de cada papel. Todos os papéis sobem HTTP com health + métricas;
 * os workers ficam ociosos até as fases que os implementam:
 * api → WalletModule (F08) + wagering (F09) · consumer → F12 · outbox → F11 · reprocessor → F10.
 */
const ROLE_MODULES: Readonly<Record<Exclude<AppRole, 'all'>, readonly Type[]>> = {
  api: [WalletModule],
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
        DatabaseModule.forRoot({ entities: [...PERSISTENCE_RECORDS] }),
        PersistenceModule,
        HttpCommonModule,
        SqsModule,
        MetricsModule,
        HealthModule,
        ...modulesFor(config.role),
      ],
    };
  }
}
