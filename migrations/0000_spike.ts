import { Migration } from '@mikro-orm/migrations';

/**
 * Migration de spike da F00: cria uma tabela trivial só para provar que o migrator
 * roda sob Bun (up/down) e que `numeric(20,2)` volta como string.
 * Será removida/substituída pela `0001_init` na F06.
 */
export class Migration0000Spike extends Migration {
  override name = '0000_spike';

  override up(): void {
    this.addSql(`
      create table spike_account (
        id uuid primary key,
        balance numeric(20, 2) not null default 0,
        version integer not null default 0
      );
    `);
  }

  override down(): void {
    this.addSql('drop table if exists spike_account;');
  }
}
