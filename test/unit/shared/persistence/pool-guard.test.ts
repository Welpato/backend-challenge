import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { type GuardablePool, guardPoolAgainstOrphanedClients } from '@/shared/persistence/pool-guard';

class FakeClient extends EventEmitter {
  releases: unknown[] = [];
  release(err?: unknown): void {
    this.releases.push(err);
  }
}

function setup(graceMs = 10) {
  const pool = new EventEmitter();
  let orphans = 0;
  guardPoolAgainstOrphanedClients(pool as unknown as GuardablePool, {
    graceMs,
    onOrphanReleased: () => {
      orphans += 1;
    },
  });
  const client = new FakeClient();
  pool.emit('connect', client);
  return { pool, client, orphans: () => orphans };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('guardPoolAgainstOrphanedClients', () => {
  it('releases with an error a checked-out client whose connection ended and nobody released', async () => {
    const { pool, client, orphans } = setup();
    pool.emit('acquire', client);
    client.emit('end');
    await wait(30);
    expect(client.releases).toHaveLength(1);
    expect(client.releases[0]).toBeInstanceOf(Error);
    expect(orphans()).toBe(1);
  });

  it('does nothing when the owner releases the client within the grace period', async () => {
    const { pool, client, orphans } = setup();
    pool.emit('acquire', client);
    client.emit('end');
    pool.emit('release', new Error('owner'), client);
    await wait(30);
    expect(client.releases).toEqual([]);
    expect(orphans()).toBe(0);
  });

  it('ignores idle clients (already released) that lose the connection', async () => {
    const { pool, client } = setup();
    pool.emit('acquire', client);
    pool.emit('release', undefined, client);
    client.emit('end');
    await wait(30);
    expect(client.releases).toEqual([]);
  });
});
