import { migrateHubStore, sqlHubStore, type SqlClient, type SqlQueryable } from './sql.js';
import type { HubStore } from './store.js';

/** The slice of a node-postgres `PoolClient` the store uses. */
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(err?: Error | boolean): void;
}

/** The slice of a node-postgres `Pool` the store uses (`pg.Pool` satisfies it). */
export interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

/** Arbitrary constant key for the migration advisory lock ("uncage" in ASCII, as an int). */
const MIGRATION_LOCK_KEY = 0x756e6361;

const asQueryable = (q: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }): SqlQueryable => ({
  query: async <T>(sql: string, params?: unknown[]) => (await q.query(sql, params)) as { rows: T[] },
});

/**
 * Runs `fn` in a transaction on one checked-out connection. A failed ROLLBACK is reported to
 * `onRollbackFailure` so the pool can discard a connection left mid-transaction.
 */
async function inTransaction<T>(client: PgClientLike, fn: (tx: SqlQueryable) => Promise<T>, onRollbackFailure?: (e: unknown) => void): Promise<T> {
  await client.query('BEGIN');
  try {
    const r = await fn(asQueryable(client));
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch((re: unknown) => onRollbackFailure?.(re));
    throw e;
  }
}

function poolClient(pool: PgPoolLike): SqlClient {
  return {
    ...asQueryable(pool),
    async transaction(fn) {
      const client = await pool.connect();
      let unusable: Error | undefined;
      try {
        return await inTransaction(client, fn, (e) => (unusable = e instanceof Error ? e : new Error(String(e))));
      } finally {
        client.release(unusable);
      }
    },
  };
}

/**
 * Hub store on a shared Postgres database — the multi-node counterpart of `pgliteHubStore`, with
 * the same tables (`uncage_hub_*`), SQL and `HubStore` contract.
 *
 * - `{ connectionString }`: the store creates a `pg.Pool` (install the `pg` package) and ends it on
 *   `close()`.
 * - `{ pool }`: your own `pg.Pool` (or anything with its `query` / `connect` / `end` shape); it
 *   is left open on `close()`.
 *
 * Migrations run on start under a Postgres advisory lock, so several nodes can start at once.
 *
 * @example
 * const store = await postgresHubStore({ connectionString: process.env.DATABASE_URL! });
 * const hub = await createHub({ ..., store, cluster: redisCluster({ url: process.env.REDIS_URL! }) });
 */
export async function postgresHubStore(o: { connectionString: string } | { pool: PgPoolLike }): Promise<HubStore> {
  let pool: PgPoolLike;
  let owned = false;
  if ('pool' in o) pool = o.pool;
  else {
    let pg: { Pool: new (c: { connectionString: string }) => PgPoolLike };
    try {
      const mod = (await import('pg')) as unknown as { default?: typeof pg } & typeof pg;
      pg = mod.default ?? mod;
    } catch (e) {
      throw new Error('postgresHubStore({ connectionString }) needs the "pg" package: npm install pg', { cause: e });
    }
    pool = new pg.Pool({ connectionString: o.connectionString });
    owned = true;
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      try {
        await migrateHubStore({ ...asQueryable(client), transaction: (fn) => inTransaction(client, fn) });
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  } catch (e) {
    if (owned) await pool.end().catch(() => undefined);
    throw e;
  }

  let closed: Promise<void> | undefined;
  return sqlHubStore(poolClient(pool), () => (closed ??= owned ? pool.end() : Promise.resolve()));
}
