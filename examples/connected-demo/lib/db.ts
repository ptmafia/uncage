/**
 * One `pg.Pool` per database URL per process (FaaS: per function instance), shared by the hub
 * store, the Postgres cluster and the asset store, so an instance holds at most `DATABASE_POOL_MAX`
 * (default 5) connections instead of one pool each. Kept on `globalThis`: Next.js bundles routes
 * separately, and server.ts shares the process with them.
 */
import type { PgPoolLike } from '@uncage/hub';
import pg from 'pg';

const POOLS_KEY = Symbol.for('uncage.connected-demo.pg-pools');
type Pools = Map<string, pg.Pool>;
const pools = (): Pools => ((globalThis as Record<symbol, Pools | undefined>)[POOLS_KEY] ??= new Map());

/** The shared pool for `url`, created on first use (connections open lazily). */
export function sharedPool(url: string, env: Record<string, string | undefined> = process.env): PgPoolLike & pg.Pool {
  let pool = pools().get(url);
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, max: Number(env.DATABASE_POOL_MAX) || 5 });
    // An idle connection dying (database restart, failover) must not crash the process.
    pool.on('error', (err) => console.error('postgres pool error:', err.message));
    pools().set(url, pool);
  }
  return pool as PgPoolLike & pg.Pool;
}

/** Ends the shared pool for `url` once (later calls, and calls for an unknown URL, do nothing). */
export async function endSharedPool(url: string): Promise<void> {
  const pool = pools().get(url);
  if (!pool) return;
  pools().delete(url);
  await pool.end();
}
