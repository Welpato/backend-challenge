import { MikroORM } from '@mikro-orm/postgresql';
import { type DynamicModule, Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@/config/app-config';
import { CLOCK, SystemClock } from '@/shared/clock';
import { buildMikroOrmConfig, type MikroOrmConfigInput } from './mikro-orm.config';
import { UnitOfWork } from './unit-of-work';

export interface DatabaseModuleOptions {
  /** Records do MikroORM (`PERSISTENCE_RECORDS`, montado na raiz de `src/` — `shared/` não importa features). */
  readonly entities: NonNullable<MikroOrmConfigInput['entities']>;
}

/**
 * Instância única do MikroORM por processo (pool de conexões compartilhado) + `UnitOfWork`.
 *
 * - Conecta com `DATABASE_URL`, que é o role `app` (só DML, `lock_timeout` 3s no role). O DDL roda à parte,
 *   como `migrator` (`scripts/migrate.ts`).
 * - `UnitOfWork` fixa `SET LOCAL lock_timeout = DB_LOCK_TIMEOUT_MS` em cada transação, sem depender do role.
 * - `CLOCK` (`SystemClock`) fica disponível para os repositórios/use cases (testes trocam por `FixedClock`).
 * - O ORM é fechado em `onApplicationShutdown`, depois que o servidor HTTP parou de aceitar requisições.
 *
 * Os repositórios (`MikroOrm*Repository`) são classes simples (construtor `uow`, `clock`) ligadas às portas
 * pelos módulos de cada feature (F08+).
 */
@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: MikroORM,
          useFactory: (config: AppConfig) =>
            MikroORM.init(buildMikroOrmConfig({ clientUrl: config.database.url, entities: options.entities })),
          inject: [APP_CONFIG],
        },
        {
          provide: UnitOfWork,
          useFactory: (orm: MikroORM, config: AppConfig) =>
            new UnitOfWork(orm, { lockTimeoutMs: config.database.lockTimeoutMs }),
          inject: [MikroORM, APP_CONFIG],
        },
        { provide: CLOCK, useClass: SystemClock },
      ],
      exports: [MikroORM, UnitOfWork, CLOCK],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
