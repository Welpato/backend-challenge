import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@/config/app-config';
import { buildMikroOrmConfig } from './mikro-orm.config';

/**
 * Instância única do MikroORM por processo (pool de conexões compartilhado).
 * Ainda sem entidades: os records entram na F07, que pode trocar este wiring por `@mikro-orm/nestjs`.
 * O ORM é fechado em `onApplicationShutdown`, depois que o servidor HTTP parou de aceitar requisições.
 */
@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      useFactory: (config: AppConfig) => MikroORM.init(buildMikroOrmConfig({ clientUrl: config.database.url })),
      inject: [APP_CONFIG],
    },
  ],
  exports: [MikroORM],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
