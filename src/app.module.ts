import { type DynamicModule, Module, type Type } from '@nestjs/common';
import type { AppConfig } from '@/config/app-config';
import { ConfigModule } from '@/config/config.module';
import type { AppRole } from '@/config/env.schema';
import { HealthModule } from '@/health/health.module';
import { OutboxModule } from '@/messaging/outbox/outbox.module';
import { ReprocessorModule } from '@/messaging/reprocessor/reprocessor.module';
import { ConsumerModule } from '@/messaging/sqs/consumer.module';
import { SqsModule } from '@/messaging/sqs/sqs.module';
import { PersistenceModule } from '@/persistence.module';
import { PERSISTENCE_RECORDS } from '@/persistence-records';
import { HttpCommonModule } from '@/shared/http/http.module';
import { AppLoggerModule } from '@/shared/observability/logger.module';
import { MetricsModule } from '@/shared/observability/metrics.module';
import { DatabaseModule } from '@/shared/persistence/database.module';
import { WageringModule } from '@/wagering/wagering.module';
import { WalletModule } from '@/wallet/wallet.module';

/**
 * Módulos específicos de cada papel. Todos os papéis sobem HTTP com health + métricas:
 * api → WalletModule (F08) + WageringModule (F09) · consumer → ConsumerModule (F12) · outbox → OutboxModule (F11) ·
 * reprocessor → ReprocessorModule (F10).
 */
const ROLE_MODULES: Readonly<Record<Exclude<AppRole, 'all'>, readonly Type[]>> = {
  api: [WalletModule, WageringModule],
  consumer: [ConsumerModule],
  outbox: [OutboxModule],
  reprocessor: [ReprocessorModule],
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
