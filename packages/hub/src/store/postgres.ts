import { HUB_MIGRATIONS, migrateHubStore, sqlHubStore, type SqlClient, type SqlQueryable } from './sql.js';
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
  on?(event: 'error', listener: (err: Error) => void): unknown;
}

/**
 * node-postgres emits `'error'` on a pool when an idle connection dies (database restart,
 * failover, network cut); with no listener that is an uncaught exception that kills the process.
 * The pool drops the broken connection and opens a new one on demand, so logging is enough.
 */
export function watchPoolErrors(pool: Pick<PgPoolLike, 'on'>, onError: (err: Error) => void): void {
  pool.on?.('error', (err) => {
    try {
      onError(err);
    } catch {
      // a throwing logger must not turn this back into a crash
    }
  });
}

/** Arbitrary constant key for the migration advisory lock ("uncage" in ASCII, as an int). */
const MIGRATION_LOCK_KEY = 0x756e6361;

const LATEST_MIGRATION = HUB_MIGRATIONS.at(-1)!.id;

/**
 * Pools / connection strings already known to be at the latest migration in this isolate, so a
 * serverless cold path does not take the advisory lock (an extra connection and round trips) on
 * every `postgresHubStore` call.
 */
const migratedPools = new WeakSet<PgPoolLike>();
const migratedUrls = new Set<string>();

/** One cheap query: is the schema already current? Any error (e.g. no table yet) means "migrate". */
async function isCurrent(pool: PgPoolLike): Promise<boolean> {
  try {
    const { rows } = await pool.query('SELECT max(id) AS id FROM uncage_hub_migrations');
    const id = (rows[0] as { id: number | string | null } | undefined)?.id;
    return id !== null && id !== undefined && Number(id) >= LATEST_MIGRATION;
  } catch {
    return false;
  }
}

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

/** A `SqlClient` over a pool: plain queries on any connection, transactions on one checked out. */
export function poolClient(pool: PgPoolLike): SqlClient {
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
 *   is left open on `close()`. **Attach your own `pool.on('error', …)` listener**: without one, an
 *   idle connection dying (e.g. a database failover) crashes the process.
 *
 * Errors of a pool the store created go to `onError` (default: `console.error`).
 *
 * Migrations run on start in one transaction under a transaction-scoped Postgres advisory lock, so
 * several nodes can start at once, also behind a transaction-mode pooler (PgBouncer, Neon `-pooler`). A
 * database already at the latest migration is detected with one `SELECT max(id)` (and remembered
 * per pool / connection string for the life of the process or isolate), skipping the lock.
 *
 * @example
 * const store = await postgresHubStore({ connectionString: process.env.DATABASE_URL! });
 * const hub = await createHub({ ..., store, cluster: redisCluster({ url: process.env.REDIS_URL! }) });
 */
export async function postgresHubStore(
  o: ({ connectionString: string } | { pool: PgPoolLike }) & { onError?: (err: Error) => void },
): Promise<HubStore> {
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
    watchPoolErrors(pool, o.onError ?? ((err) => console.error('[uncage] postgres pool error:', err.message)));
  }

  const url = 'connectionString' in o ? o.connectionString : undefined;
  try {
    const known = url !== undefined ? migratedUrls.has(url) : migratedPools.has(pool);
    if (!known && !(await isCurrent(pool))) {
      // One transaction under a transaction-scoped advisory lock: works behind a transaction-mode
      // pooler (PgBouncer, Neon's -pooler host), where a session-level lock taken on one server
      // connection and released on another would leak and block every later migrator.
      const client = await pool.connect();
      let unusable: Error | undefined;
      try {
        await inTransaction(
          client,
          async (tx) => {
            await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
            // Already inside the transaction: each migration's own transaction is this one.
            await migrateHubStore({ ...tx, transaction: (fn) => fn(tx) });
          },
          (e) => (unusable = e instanceof Error ? e : new Error(String(e))),
        );
      } finally {
        client.release(unusable);
      }
    }
    if (url !== undefined) migratedUrls.add(url);
    else migratedPools.add(pool);
  } catch (e) {
    if (owned) await pool.end().catch(() => undefined);
    throw e;
  }

  let closed: Promise<void> | undefined;
  return sqlHubStore(poolClient(pool), () => (closed ??= owned ? pool.end() : Promise.resolve()));
}
