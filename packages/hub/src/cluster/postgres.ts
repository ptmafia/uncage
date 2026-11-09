import { poolClient, watchPoolErrors, type PgPoolLike } from '../store/postgres.js';
import type { SqlClient } from '../store/sql.js';
import type { ClusterAdapter } from './cluster.js';

export interface PostgresClusterOptions {
  /** Poll interval while there is traffic (ms). Default 300. */
  activePollMs?: number;
  /** Poll interval once quiet: the interval doubles from `activePollMs` up to this (ms). Default 2 000. */
  idlePollMs?: number;
  /** After a delivered or locally published message, poll at `activePollMs` for this long (ms). Default 30 000. */
  activeWindowMs?: number;
  /**
   * How long a missing message id (a publish whose transaction has not committed yet, or rolled
   * back) is waited for before the reader moves past it (ms). Default 2 000.
   */
  gapTimeoutMs?: number;
  /** Messages older than this are deleted, by any instance, every 30 s (ms). Default 60 000. */
  retentionMs?: number;
  /** Poll / retention / connection errors (default: `console.error`). */
  onError?(err: Error): void;
}

/** Plain Postgres DDL, applied in order and recorded in `uncage_cluster_migrations`. */
export const CLUSTER_MIGRATIONS: readonly { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE uncage_cluster_messages (
  id bigserial PRIMARY KEY,
  channel text NOT NULL,
  msg text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE uncage_cluster_presence (
  machine_id text PRIMARY KEY,
  node_id text NOT NULL,
  expires_at timestamptz NOT NULL
)
`,
  },
];

const LATEST_MIGRATION = CLUSTER_MIGRATIONS.at(-1)!.id;
/** Advisory lock key for cluster migrations ("uncc" in ASCII); the store uses its own key. */
const CLUSTER_MIGRATION_LOCK_KEY = 0x756e6363;
/** Retention runs at most this often per instance. */
const PRUNE_INTERVAL_MS = 30_000;
/** Rows per poll query; a full page polls again right away. */
const POLL_LIMIT = 1_000;
/** Messages per INSERT when publishes queue up. */
const PUBLISH_BATCH = 100;
/** Skipped ids remembered for the late-commit check (oldest dropped beyond this). */
const MAX_SKIPPED = 1_000;

/** Databases (client / pool objects, or connection strings) known to be migrated in this isolate. */
const migratedObjects = new WeakSet<object>();
const migratedUrls = new Set<string>();
type MigrationKey = object | string;
const isMigrated = (k: MigrationKey) => (typeof k === 'string' ? migratedUrls.has(k) : migratedObjects.has(k));
const markMigrated = (k: MigrationKey) => (typeof k === 'string' ? migratedUrls.add(k) : migratedObjects.add(k));

/**
 * Applies `CLUSTER_MIGRATIONS` in one transaction under a transaction-scoped advisory lock, so
 * several instances can start at once (and it works on any `SqlClient`, including one whose plain
 * queries go to different pool connections). A current schema costs one `SELECT max(id)`.
 */
async function migrateCluster(db: SqlClient): Promise<void> {
  try {
    const { rows } = await db.query<{ id: number | string | null }>('SELECT max(id) AS id FROM uncage_cluster_migrations');
    const id = rows[0]?.id;
    if (id !== null && id !== undefined && Number(id) >= LATEST_MIGRATION) return;
  } catch {
    // no table yet: migrate
  }
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [CLUSTER_MIGRATION_LOCK_KEY]);
    await tx.query('CREATE TABLE IF NOT EXISTS uncage_cluster_migrations (id integer PRIMARY KEY)');
    const done = await tx.query<{ id: number }>('SELECT id FROM uncage_cluster_migrations');
    const applied = new Set(done.rows.map((r) => Number(r.id)));
    for (const m of CLUSTER_MIGRATIONS) {
      if (applied.has(m.id)) continue;
      for (const stmt of m.sql.split(';').map((s) => s.trim()).filter(Boolean)) await tx.query(stmt);
      await tx.query('INSERT INTO uncage_cluster_migrations (id) VALUES ($1)', [m.id]);
    }
  });
}

interface Sub {
  channel: string;
  fn: (msg: string) => void;
  /** Only messages with a higher id are delivered (the max id when the subscription started). */
  after: number;
  active: boolean;
}

interface Pending {
  channel: string;
  msg: string;
  resolve: () => void;
  reject: (e: unknown) => void;
}

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

function createSqlCluster(
  getDb: () => Promise<SqlClient>,
  key: MigrationKey,
  o: PostgresClusterOptions,
  closeDb: () => Promise<void>,
): ClusterAdapter {
  const activePollMs = o.activePollMs ?? 300;
  const idlePollMs = Math.max(o.idlePollMs ?? 2_000, activePollMs);
  const activeWindowMs = o.activeWindowMs ?? 30_000;
  const gapTimeoutMs = o.gapTimeoutMs ?? 2_000;
  const retentionMs = o.retentionMs ?? 60_000;
  /** A skipped id is looked up once this long after it was skipped (10 s at the default gap timeout). */
  const recheckAfterMs = 5 * gapTimeoutMs;
  const report = (e: unknown) => {
    try {
      (o.onError ?? ((err: Error) => console.error('[uncage] postgres cluster error:', err.message)))(toError(e));
    } catch {
      // a throwing logger must not break the poll loop
    }
  };

  let readyP: Promise<SqlClient> | undefined;
  const ready = (): Promise<SqlClient> =>
    (readyP ??= (async () => {
      const db = await getDb();
      if (!isMigrated(key)) {
        await migrateCluster(db);
        markMigrated(key);
      }
      return db;
    })().catch((e: unknown) => {
      readyP = undefined; // retry on the next call
      throw e;
    }));

  let closed = false;
  let closing: Promise<void> | undefined;
  /** Background work (retention) that `close()` waits for. */
  const inflight = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    const t = p.catch(report).finally(() => inflight.delete(t));
    inflight.add(t);
  };

  // --- subscriptions and the poll loop ---------------------------------------------------------
  const subs = new Map<string, Set<Sub>>();
  let subCount = 0;
  /** Every id <= low has been seen or given up on. */
  let low = 0;
  /** Ids > low already seen (delivered, or not for us). */
  const seen = new Set<number>();
  /** Ids > low not seen yet, with when they were first found missing. */
  const missing = new Map<number, number>();
  /** Ids given up on after `gapTimeoutMs`, re-checked once `recheckAfterMs` later to report late commits. */
  const skipped: Array<{ id: number; at: number }> = [];
  const skip = (id: number, at: number) => {
    skipped.push({ id, at });
    if (skipped.length > MAX_SKIPPED) skipped.shift();
  };
  let lastActivity = -Infinity;
  let interval = activePollMs;
  let loopRunning = false;
  let pollAgain = false;
  let wake: (() => void) | undefined;
  /** Serializes polls with subscription starts, so a start's max id and the poll state agree. */
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = chain.then(fn);
    chain = r.catch(() => undefined);
    return r;
  };

  const activity = () => {
    lastActivity = Date.now();
    interval = activePollMs;
  };

  /** Poll now: wakes a sleeping loop, or makes a running poll go again right after. */
  const kick = () => {
    if (!loopRunning) return;
    if (wake) wake();
    else pollAgain = true;
  };

  function advance(): void {
    const t = Date.now();
    let maxSeen = low;
    for (const id of seen) if (id > maxSeen) maxSeen = id;
    let blocked = false;
    for (let id = low + 1; id <= maxSeen; id++) {
      if (seen.has(id)) {
        if (!blocked) {
          seen.delete(id);
          low = id;
        }
        continue;
      }
      let since = missing.get(id);
      if (since === undefined) missing.set(id, (since = t));
      if (t - since >= gapTimeoutMs) {
        if (!blocked) {
          missing.delete(id);
          low = id;
          skip(id, t);
        }
      } else blocked = true;
    }
  }

  async function pollOnce(): Promise<void> {
    const db = await ready();
    const channels = [...subs.keys()];
    if (channels.length === 0) return;
    // Every id after `low` (to tell uncommitted gaps from other channels' messages), with the body
    // only for our channels.
    const { rows } = await db.query<{ id: string | number; channel: string; msg: string | null }>(
      `SELECT id::text AS id, channel, CASE WHEN channel = ANY($2::text[]) THEN msg END AS msg
       FROM uncage_cluster_messages WHERE id > $1::bigint ORDER BY uncage_cluster_messages.id LIMIT ${POLL_LIMIT}`,
      [String(low), channels],
    );
    let delivered = false;
    for (const r of rows) {
      const id = Number(r.id);
      if (id <= low || seen.has(id)) continue;
      seen.add(id);
      missing.delete(id);
      if (r.msg === null) continue;
      for (const sub of [...(subs.get(r.channel) ?? [])]) {
        if (!sub.active || id <= sub.after) continue;
        delivered = true;
        try {
          sub.fn(r.msg);
        } catch (e) {
          report(e);
        }
      }
    }
    if (delivered) activity();
    advance();
    await recheckSkipped(db, channels);
    if (rows.length === POLL_LIMIT) pollAgain = true;
  }

  /**
   * A skipped id that exists now committed after the reader gave up on it: its message was not
   * delivered (at-most-once). Reported, once per id, when it was on one of our channels.
   */
  async function recheckSkipped(db: SqlClient, channels: string[]): Promise<void> {
    const t = Date.now();
    let due = 0;
    while (due < skipped.length && t - skipped[due]!.at >= recheckAfterMs) due++;
    if (due === 0) return;
    const ids = skipped.slice(0, due).map((s) => String(s.id));
    const { rows } = await db.query<{ id: string | number; channel: string }>(
      'SELECT id::text AS id, channel FROM uncage_cluster_messages WHERE id = ANY($1::bigint[]) AND channel = ANY($2::text[])',
      [ids, channels],
    );
    skipped.splice(0, due); // after the query: a failed check is retried on the next poll
    for (const r of rows) {
      report(
        new Error(
          `postgresCluster: late commit after gapTimeoutMs (${gapTimeoutMs} ms), message dropped (id ${String(r.id)}, channel "${r.channel}")`,
        ),
      );
    }
  }

  function nextInterval(): number {
    if (Date.now() - lastActivity < activeWindowMs) interval = activePollMs;
    else interval = Math.min(idlePollMs, interval * 2);
    return interval;
  }

  async function loop(): Promise<void> {
    try {
      while (!closed && subCount > 0) {
        pollAgain = false;
        let failed = false;
        try {
          await exclusive(pollOnce);
        } catch (e) {
          failed = true;
          report(e);
        }
        maybePrune();
        if (closed || subCount === 0) break;
        if (pollAgain && !failed) continue;
        const ms = failed ? idlePollMs : nextInterval();
        await new Promise<void>((resolve) => {
          const done = () => {
            wake = undefined;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, ms);
          wake = done;
        });
      }
    } finally {
      loopRunning = false;
    }
    if (!closed && subCount > 0) startLoop(); // a subscription arrived while the loop was exiting
  }

  function startLoop(): void {
    if (loopRunning || closed) return;
    loopRunning = true;
    void loop();
  }

  // --- retention -------------------------------------------------------------------------------
  // Jittered first run (within one interval), so instances started together do not prune together.
  let lastPrune = Date.now() - Math.random() * PRUNE_INTERVAL_MS;
  function maybePrune(): void {
    if (closed || Date.now() - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = Date.now();
    track(
      (async () => {
        const db = await ready();
        await db.query(`DELETE FROM uncage_cluster_messages WHERE created_at < now() - ($1::double precision * interval '1 millisecond')`, [
          retentionMs,
        ]);
        await db.query('DELETE FROM uncage_cluster_presence WHERE expires_at <= now()');
      })(),
    );
  }

  // --- publishing ------------------------------------------------------------------------------
  // One INSERT at a time per instance (queued publishes go together in one multi-row INSERT), so
  // this instance's messages get ids, and become visible, in publish order.
  const queue: Pending[] = [];
  /** The running flush (it clears this itself, synchronously with seeing an empty queue). */
  let flushing: Promise<void> | undefined;
  async function flush(): Promise<void> {
    await Promise.resolve(); // let `flushing` be assigned before the loop can finish
    while (queue.length > 0) {
      const batch = queue.splice(0, PUBLISH_BATCH);
      try {
        const db = await ready();
        await db.query(
          `INSERT INTO uncage_cluster_messages (channel, msg) VALUES ${batch.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ')}`,
          batch.flatMap((b) => [b.channel, b.msg]),
        );
        for (const b of batch) b.resolve();
      } catch (e) {
        for (const b of batch) b.reject(e);
      }
      activity();
      kick();
      maybePrune();
    }
    flushing = undefined;
  }

  const closedError = () => new Error('postgresCluster is closed');

  return {
    publish(channel, msg) {
      if (closed) return Promise.reject(closedError());
      return new Promise<void>((resolve, reject) => {
        queue.push({ channel, msg, resolve, reject });
        flushing ??= flush();
      });
    },

    async subscribe(channel, fn) {
      if (closed) throw closedError();
      const db = await ready();
      const sub: Sub = { channel, fn, after: 0, active: true };
      await exclusive(async () => {
        if (closed) throw closedError();
        const { rows } = await db.query<{ id: string | number | null }>('SELECT max(id)::text AS id FROM uncage_cluster_messages');
        sub.after = Number(rows[0]?.id ?? 0);
        if (subCount === 0) {
          // Restarting from idle: skip everything committed so far.
          low = Math.max(low, sub.after);
          for (const id of seen) if (id <= low) seen.delete(id);
          for (const id of missing.keys()) if (id <= low) missing.delete(id);
        }
        let set = subs.get(channel);
        if (!set) subs.set(channel, (set = new Set()));
        set.add(sub);
        subCount++;
      });
      activity();
      startLoop();
      kick(); // a sleeping loop (up to idlePollMs) polls now, then at activePollMs
      return () => {
        if (!sub.active) return;
        sub.active = false;
        subCount--;
        const set = subs.get(channel);
        set?.delete(sub);
        if (set && set.size === 0) subs.delete(channel);
      };
    },

    async setPresence(machineId, nodeId, ttlSec) {
      if (closed) throw closedError();
      const db = await ready();
      await db.query(
        `INSERT INTO uncage_cluster_presence (machine_id, node_id, expires_at)
         VALUES ($1, $2, now() + ($3::double precision * interval '1 second'))
         ON CONFLICT (machine_id) DO UPDATE SET node_id = EXCLUDED.node_id, expires_at = EXCLUDED.expires_at`,
        [machineId, nodeId, ttlSec],
      );
    },

    async refreshPresence(machineId, nodeId, ttlSec) {
      if (closed) throw closedError();
      const db = await ready();
      const { rows } = await db.query(
        `INSERT INTO uncage_cluster_presence AS p (machine_id, node_id, expires_at)
         VALUES ($1, $2, now() + ($3::double precision * interval '1 second'))
         ON CONFLICT (machine_id) DO UPDATE SET node_id = EXCLUDED.node_id, expires_at = EXCLUDED.expires_at
         WHERE p.node_id = EXCLUDED.node_id OR p.expires_at <= now()
         RETURNING 1`,
        [machineId, nodeId, ttlSec],
      );
      return rows.length > 0;
    },

    async getPresence(machineId) {
      if (closed) throw closedError();
      const db = await ready();
      const { rows } = await db.query<{ node_id: string }>(
        'SELECT node_id FROM uncage_cluster_presence WHERE machine_id = $1 AND expires_at > now()',
        [machineId],
      );
      return rows[0]?.node_id ?? null;
    },

    async clearPresence(machineId, nodeId) {
      if (closed) throw closedError();
      const db = await ready();
      await db.query('DELETE FROM uncage_cluster_presence WHERE machine_id = $1 AND node_id = $2', [machineId, nodeId]);
    },

    close() {
      return (closing ??= (async () => {
        closed = true;
        wake?.();
        await flushing;
        await chain;
        await Promise.all([...inflight]);
        for (const set of subs.values()) for (const s of set) s.active = false;
        subs.clear();
        subCount = 0;
        await closeDb();
      })());
    },
  };
}

/**
 * Cluster adapter on any `SqlClient` (e.g. PGlite in tests, or the same client a `sqlHubStore`
 * uses). See `postgresCluster` for the behaviour. `close` (optional) runs on `close()`; the client
 * is otherwise left open.
 */
export function sqlCluster(db: SqlClient, o: PostgresClusterOptions & { close?: () => Promise<void> } = {}): ClusterAdapter {
  return createSqlCluster(async () => db, db, o, o.close ?? (async () => undefined));
}

/**
 * Cluster adapter on Postgres, so FaaS instances (or Node processes) sharing one database need no
 * Redis: messages are rows in `uncage_cluster_messages` that every subscribed instance polls
 * (adaptive: `activePollMs` while there is traffic, backing off to `idlePollMs` when quiet; a local
 * publish polls right away), presence is a row per machine with an expiry on the database clock.
 *
 * Delivery is at-most-once with a bounded gap: a message whose transaction commits after a higher
 * id is still delivered if it commits within `gapTimeoutMs` (2 s) of the reader first missing its
 * id; after that the reader moves past it (normal for rolled-back publishes). A skipped id that does
 * commit later is reported through `onError` ("late commit after gapTimeoutMs, message dropped"),
 * checked once about 5 × `gapTimeoutMs` after the skip. Each instance's publishes are delivered in
 * publish order. Messages older than `retentionMs` are deleted by any instance every 30 s.
 *
 * - `{ connectionString }`: the adapter creates a `pg.Pool` (install the `pg` package) and ends it
 *   on `close()`; its errors go to `onError`.
 * - `{ pool }`: your own `pg.Pool` (or anything with its shape), left open on `close()`. Attach
 *   your own `pool.on('error', …)` listener.
 *
 * A node that keeps a subscription open (a long-running Node process with machine WebSockets
 * subscribes to its node channel for its whole life) polls at least every `idlePollMs` (2 s), which
 * keeps a serverless database (e.g. Neon) from auto-suspending; raise `idlePollMs` if that matters.
 *
 * Tables are created on first use under an advisory lock (once per pool / connection string per
 * process or isolate).
 *
 * @example
 * const cluster = postgresCluster({ connectionString: process.env.DATABASE_URL! });
 */
export function postgresCluster(o: ({ connectionString: string } | { pool: PgPoolLike }) & PostgresClusterOptions): ClusterAdapter {
  if ('pool' in o) {
    const db = poolClient(o.pool);
    return createSqlCluster(async () => db, o.pool, o, async () => undefined);
  }
  const { connectionString } = o;
  let poolP: Promise<PgPoolLike> | undefined;
  const pool = (): Promise<PgPoolLike> =>
    (poolP ??= (async () => {
      let pg: { Pool: new (c: { connectionString: string }) => PgPoolLike };
      try {
        const mod = (await import(/* webpackIgnore: true */ 'pg')) as unknown as { default?: typeof pg } & typeof pg;
        pg = mod.default ?? mod;
      } catch (e) {
        poolP = undefined;
        throw new Error('postgresCluster({ connectionString }) needs the "pg" package: npm install pg', { cause: e });
      }
      const p = new pg.Pool({ connectionString });
      watchPoolErrors(p, o.onError ?? ((err) => console.error('[uncage] postgres cluster pool error:', err.message)));
      return p;
    })());
  return createSqlCluster(
    async () => poolClient(await pool()),
    `url:${connectionString}`,
    o,
    async () => {
      if (poolP) await (await poolP.catch(() => undefined))?.end();
    },
  );
}
