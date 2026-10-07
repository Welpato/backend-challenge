import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import type { HealthIndicator } from './health-indicator';

/** `SELECT 1` pelo pool do ORM — o mesmo caminho que a aplicação usa. */
@Injectable()
export class PostgresHealthIndicator implements HealthIndicator {
  readonly name = 'postgres';

  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async check(): Promise<void> {
    await this.orm.em.getConnection().execute('select 1');
  }
}
