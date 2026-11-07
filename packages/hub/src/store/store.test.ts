import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { hubStoreContract } from './contract.js';
import { pgliteHubStore } from './pglite.js';
import { postgresHubStore, type PgPoolLike } from './postgres.js';
import { HUB_MIGRATIONS } from './sql.js';

describe('pgliteHubStore', () => {
  hubStoreContract(async () => ({ store: await pgliteHubStore({ dataDir: 'memory://' }) }));
});

/**
 * A one-connection `pg.Pool` stand-in over PGlite: `connect()` hands out the connection
 * exclusively until `release()`, like a pool of size 1. Exercises postgresHubStore's own code
 * (transactions over a checked-out client, advisory-locked migrations) without a server.
 */
function pglitePool(pg: PGlite): PgPoolLike & { ended: boolean } {
  let lock: Promise<void> = Promise.resolve();
  const acquire = async (): Promise<() => void> => {
    let release!: () => void;
    const prev = lock;
    lock = new Promise<void>((r) => (release = r));
    await prev;
    return release;
  };
  const run = async (sql: string, params?: unknown[]) => {
    const r = await pg.query(sql, params as unknown[]);
    return { rows: r.rows as never[] };
  };
  const pool = {
    ended: false,
    async query(sql: string, params?: unknown[]) {
      const release = await acquire();
      try {
        return await run(sql, params);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await acquire();
      return { query: run, release };
    },
    async end() {
      pool.ended = true;
    },
  };
  return pool as PgPoolLike & { ended: boolean };
}

describe('postgresHubStore (pg Pool adapter, PGlite-backed)', () => {
  hubStoreContract(async () => {
    const pg = new PGlite('memory://');
    return { store: await postgresHubStore({ pool: pglitePool(pg) }), cleanup: () => pg.close() };
  });

  it('applies every migration once (concurrent starts serialize) and leaves a caller-owned pool open', async () => {
    const pg = new PGlite('memory://');
    const pool = pglitePool(pg);
    const [a, b] = await Promise.all([postgresHubStore({ pool }), postgresHubStore({ pool })]);
    const { rows } = await pool.query('SELECT id FROM uncage_hub_migrations ORDER BY id');
    expect(rows.map((r) => (r as { id: number }).id)).toEqual(HUB_MIGRATIONS.map((m) => m.id));
    await a.close();
    await b.close();
    expect(pool.ended).toBe(false);
    await pg.close();
  });
});
