/**
 * Proteção do pool de conexões contra vazamento quando o PostgreSQL derruba uma conexão no meio de uma
 * transação (restart, failover, `pg_terminate_backend`).
 *
 * O problema (Kysely 0.29 sob o MikroORM 7): `ControlledTransaction.rollback()` só devolve a conexão ao pool
 * **depois** que o `ROLLBACK` dá certo. Com a conexão morta, o `ROLLBACK` falha, o MikroORM registra o erro
 * e propaga o erro original — e o client do `pg-pool` fica para sempre "em uso". Cada queda de conexão
 * durante uma transação consome uma vaga do pool; esgotado o pool, a instância trava (e `orm.close()` não
 * termina). Reproduzido no teste "classifies a connection killed by the server as transient".
 *
 * A correção: acompanhamos quais clients estão emprestados (`acquire`/`release` do pool). Quando um client
 * emprestado perde a conexão (`end`), esperamos `graceMs` — tempo para o dono normal (consulta fora de
 * transação, que libera em `finally`) devolvê-lo — e, se ninguém devolveu, devolvemos nós com erro
 * (`release(err)`), o que faz o pool descartá-lo. Nunca liberamos um client vivo nem um já devolvido.
 */

/** Subconjunto do `pg.PoolClient` usado aqui (tipagem estrutural; o `pg` vem do `@mikro-orm/postgresql`). */
interface GuardedClient {
  release(err?: Error | boolean): void;
  once(event: 'end', listener: () => void): unknown;
}

/** Subconjunto do `pg.Pool` usado aqui. */
export interface GuardablePool {
  on(event: 'acquire', listener: (client: GuardedClient) => void): unknown;
  on(event: 'release', listener: (err: Error | undefined, client: GuardedClient) => void): unknown;
  on(event: 'connect', listener: (client: GuardedClient) => void): unknown;
}

export interface PoolGuardOptions {
  /** Espera antes de devolver um client órfão. Default: 1s. */
  readonly graceMs?: number;
  /** Chamado quando um client órfão é devolvido (log/métrica). */
  readonly onOrphanReleased?: () => void;
}

export function guardPoolAgainstOrphanedClients(pool: GuardablePool, options: PoolGuardOptions = {}): void {
  const graceMs = options.graceMs ?? 1_000;
  const checkedOut = new WeakSet<GuardedClient>();

  pool.on('acquire', (client) => {
    checkedOut.add(client);
  });
  pool.on('release', (_err, client) => {
    checkedOut.delete(client);
  });
  pool.on('connect', (client) => {
    client.once('end', () => {
      if (!checkedOut.has(client)) {
        return;
      }
      setTimeout(() => {
        if (!checkedOut.has(client)) {
          return;
        }
        checkedOut.delete(client);
        client.release(new Error('Connection lost while checked out; released by pool guard'));
        options.onOrphanReleased?.();
      }, graceMs);
    });
  });
}
