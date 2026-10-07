import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HEALTH_INDICATORS, type HealthIndicator } from './health-indicator';
import { PostgresHealthIndicator } from './postgres.indicator';
import { ReadinessService } from './readiness.service';
import { SqsHealthIndicator } from './sqs.indicator';

/** Depende de `DatabaseModule` e `SqsModule` (globais, registrados no `AppModule`). */
@Module({
  controllers: [HealthController],
  providers: [
    PostgresHealthIndicator,
    SqsHealthIndicator,
    {
      provide: HEALTH_INDICATORS,
      useFactory: (postgres: HealthIndicator, sqs: HealthIndicator): HealthIndicator[] => [postgres, sqs],
      inject: [PostgresHealthIndicator, SqsHealthIndicator],
    },
    ReadinessService,
  ],
})
export class HealthModule {}
