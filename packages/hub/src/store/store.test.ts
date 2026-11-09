import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { hubStoreContract } from './contract.js';
import { pgliteHubStore } from '../node/index.js';
import { postgresHubStore, type PgPoolLike } from './postgres.js';
import { HUB_MIGRATIONS, migrateHubStore, sqlHubStore, type SqlClient } from './sql.js';

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

describe('postgresHubStore migration fast path', () => {
  /** Records every statement sent through the pool or a checked-out client. */
  function recording(pool: PgPoolLike): { pool: PgPoolLike; sql: string[] } {
    const sql: string[] = [];
    return {
      sql,
      pool: {
        query: (q, p) => (sql.push(q), pool.query(q, p)),
        connect: async () => {
          const c = await pool.connect();
          return { query: (q, p) => (sql.push(q), c.query(q, p)), release: (e) => c.release(e) };
        },
        end: () => pool.end(),
      },
    };
  }

  it('skips the advisory lock once this pool is known to be migrated, or a max(id) check confirms it', async () => {
    const pg = new PGlite('memory://');
    const base = pglitePool(pg);
    const first = recording(base);
    await (await postgresHubStore({ pool: first.pool })).close();
    expect(first.sql.some((q) => q.includes('pg_advisory_xact_lock'))).toBe(true);
    // Transaction-scoped only (transaction-mode poolers): no session lock, the lock sits inside BEGIN … COMMIT.
    expect(first.sql.some((q) => /pg_advisory_(un)?lock\(/.test(q))).toBe(false);
    expect(first.sql.indexOf('BEGIN')).toBeLessThan(first.sql.findIndex((q) => q.includes('pg_advisory_xact_lock')));
    expect(first.sql.at(-1)).toBe('COMMIT');

    const again = recording(base); // a new wrapper object: no memo, but the database is current
    await (await postgresHubStore({ pool: again.pool })).close();
    expect(again.sql.some((q) => q.includes('pg_advisory_xact_lock'))).toBe(false);
    expect(again.sql.filter((q) => q.includes('max(id)'))).toHaveLength(1);

    const third = recording(base);
    await (await postgresHubStore({ pool: third.pool })).close();
    await (await postgresHubStore({ pool: third.pool })).close(); // memoized: no query at all
    expect(third.sql.filter((q) => q.includes('max(id)'))).toHaveLength(1);
    expect(third.sql.some((q) => q.includes('pg_advisory_xact_lock'))).toBe(false);
    await pg.close();
  });

  it('migrates a database left at an older version under the lock', async () => {
    const pg = new PGlite('memory://');
    await pg.query('CREATE TABLE uncage_hub_migrations (id integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const m of HUB_MIGRATIONS.filter((x) => x.id < 7)) {
      for (const stmt of m.sql.split(';').map((x) => x.trim()).filter(Boolean)) await pg.query(stmt);
      await pg.query('INSERT INTO uncage_hub_migrations (id) VALUES ($1)', [m.id]);
    }
    // An older hub could write two audit rows for one resent call id: both survive migration 7.
    for (const [id, at] of [['tcl_b', '2026-01-02'], ['tcl_a', '2026-01-01']]) {
      await pg.query(
        `INSERT INTO uncage_hub_tool_calls (id, call_id, session_id, run_id, user_id, machine_id, tool, status, started_at) VALUES ($1, 'tc_1', 's', 'r', 'u', 'm', 'x', 'ok', $2)`,
        [id, at],
      );
    }
    const rec = recording(pglitePool(pg));
    const store = await postgresHubStore({ pool: rec.pool });
    expect((await store.listToolCalls('s')).map((r) => [r.id, r.callId])).toEqual([['tcl_a', 'tc_1'], ['tcl_b', 'tc_1#tcl_b']]);
    expect(rec.sql.some((q) => q.includes('pg_advisory_xact_lock'))).toBe(true);
    const { rows } = await pg.query<{ id: number }>('SELECT id FROM uncage_hub_migrations ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual(HUB_MIGRATIONS.map((m) => m.id));
    expect(await store.tryLease('x', { holder: 'a', until: '2', now: '1' })).toBe(true);
    await store.close();
    await pg.close();
  });
});

describe('bindRunManifest error handling', () => {
  const failing = (err: unknown) =>
    sqlHubStore(
      {
        query: async () => {
          throw err;
        },
        transaction: async () => {
          throw err;
        },
      },
      async () => undefined,
    );

  it('swallows only unique violations (23505); anything else rejects', async () => {
    await expect(failing(Object.assign(new Error('duplicate key'), { code: '23505' })).bindRunManifest('k', 'r')).resolves.toBeUndefined();
    await expect(failing(Object.assign(new Error('terminating connection'), { code: '57P01' })).bindRunManifest('k', 'r')).rejects.toThrow('terminating connection');
    await expect(failing(new Error('socket hang up')).bindRunManifest('k', 'r')).rejects.toThrow('socket hang up');
  });

  it('PGlite reports a UNIQUE(run_id) clash as SQLSTATE 23505', async () => {
    const pg = new PGlite('memory://');
    await migrateHubStore(pg as unknown as SqlClient);
    await pg.query(`INSERT INTO uncage_hub_run_manifests (key, session_id, run_id, tools, created_at) VALUES ('a', 's', 'run_1', '[]', 'x')`);
    const err = await pg.query(`INSERT INTO uncage_hub_run_manifests (key, session_id, run_id, tools, created_at) VALUES ('b', 's', 'run_1', '[]', 'x')`).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('23505');
    await pg.close();
  });
});
