/**
 * This Worker's Uncage hub. Workers forbid reusing I/O objects (sockets) across requests, so every
 * request gets its own `pg.Pool` and its own hub (`fetchOnce` in worker.ts closes both once the
 * response is done); everything shared between requests and isolates lives in Postgres:
 * `postgresHubStore` (machines, sessions, outbox, rate limits, tool calls) and `postgresCluster`
 * (wake-ups between instances).
 *
 * Migrations are remembered per pool object, so a fresh pool costs one `SELECT max(id)` for the
 * store (and one for the cluster tables, on the requests that use them) — no lock, no DDL.
 */
import { createHub, postgresCluster, postgresHubStore, type Hub, type PgPoolLike } from '@uncage/hub';
import pg from 'pg';
import { userFromRequest } from './auth.ts';
import { notesSkill } from './skills.ts';
import { notesDb, saveNoteTool } from './tools.ts';

export interface Env {
  /** Hyperdrive binding (wrangler.toml); `wrangler dev` uses its `localConnectionString`. */
  HYPERDRIVE: { connectionString: string };
  /** At least 32 bytes: signs the demo sign-in cookie (`wrangler secret put DEMO_SECRET`). */
  DEMO_SECRET: string;
  /** The Worker's public origin, e.g. `https://uncage-demo.example.workers.dev`. */
  PUBLIC_URL: string;
  /** Enables `GET|POST /api/uncage/maintenance` with `Authorization: Bearer <CRON_SECRET>`. */
  CRON_SECRET?: string;
}

/** A pool for one request. At most 5 connections (a Worker may open 6 at once). */
export function newPool(env: Env): PgPoolLike {
  const pool = new pg.Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
  let ending = false;
  // An idle connection dying must not become an uncaught error. While the pool ends, workerd
  // reports its idle sockets closing as "This socket has been closed": expected, not logged.
  pool.on('error', (err) => {
    if (!ending) console.error('postgres pool error:', err.message);
  });
  const end = pool.end.bind(pool);
  return Object.assign(pool, {
    end: () => {
      ending = true;
      return end();
    },
  });
}

/**
 * The hub for one request on `pool` (yours: end it after `close()`). Returns what `fetchOnce`'s
 * `create` takes: the hub and the cleanup of the cluster and store built for it.
 */
export async function makeHub(env: Env, pool: PgPoolLike): Promise<{ hub: Hub; close(): Promise<void> }> {
  const store = await postgresHubStore({ pool });
  const cluster = postgresCluster({ pool });
  const notes = notesDb(pool, env.HYPERDRIVE.connectionString);
  try {
    const hub = await createHub({
      publicUrl: env.PUBLIC_URL,
      getUser: (req) => userFromRequest(req, env.DEMO_SECRET),
      store,
      cluster,
      tools: [saveNoteTool(notes)],
      skills: [notesSkill],
      // The Worker keeps a replica of every conversation: history stays readable with the machine off.
      sessionStorage: 'site',
      site: { name: 'Uncage on Cloudflare Workers' },
      ...(env.CRON_SECRET ? { maintenance: { secret: env.CRON_SECRET } } : {}),
    });
    return {
      hub,
      close: async () => {
        await cluster.close();
        await store.close(); // leaves `pool` open: the caller ends it
      },
    };
  } catch (e) {
    await cluster.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    throw e;
  }
}
