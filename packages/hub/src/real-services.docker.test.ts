/** Real Redis + real Postgres (containers from docker-setup.ts). Runs only with UNCAGE_DOCKER_TESTS=1. */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { clusterContract } from './cluster/contract.js';
import { postgresCluster } from './cluster/postgres.js';
import { redisCluster } from './cluster/redis.js';
import { runFaasScenario } from './faas-scenario.js';
import { runMultiNodeScenario } from './multinode-scenario.js';
import { hubStoreContract } from './store/contract.js';
import { postgresHubStore } from './store/postgres.js';
import { until } from './test-utils.js';

const admin = new pg.Pool({ connectionString: inject('postgresUrl') });
afterAll(() => admin.end());

/** A fresh, empty database per store. */
async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `uncage_${randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(inject('postgresUrl'));
  url.pathname = `/${name}`;
  return { url: url.toString(), drop: async () => void (await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)) };
}

describe('postgresHubStore on Postgres 16', () => {
  hubStoreContract(async () => {
    const db = await freshDatabase();
    return { store: await postgresHubStore({ connectionString: db.url }), cleanup: db.drop };
  });
});

describe('postgresHubStore outbox on Postgres 16 (Review Focus #1)', () => {
  it('enqueueOutbox under 50 concurrent writers: a reader advancing its cursor sees every item exactly once', async () => {
    const db = await freshDatabase();
    const pool = new pg.Pool({ connectionString: db.url, max: 20 });
    pool.on('error', () => undefined); // caller-owned pool: the forced DROP DATABASE below kills idle connections
    const store = await postgresHubStore({ pool });
    try {
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const at = new Date().toISOString();
      await store.insertMachine({ id: 'm', userId: 'u', tokenHash: 'h', name: 'M', os: 'linux', agentVersion: '0.3.0', runtimes: [], createdAt: at, lastSeenAt: at });
      await store.openLink('m', { linkId: 'lnk', transport: 'http', at });
      const seen: string[] = [];
      let cursor = 0;
      let writing = true;
      const reader = (async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const done = !writing;
          const { items } = await store.pollLink('m', 'lnk', { after: cursor, limit: 7, now: new Date().toISOString() });
          for (const i of items) seen.push(i.msgId);
          if (items.length > 0) cursor = Math.max(...items.map((i) => i.seq));
          else if (done) return;
        }
      })();
      // Each writer is its own transaction on its own pool connection; a jitter spreads commits.
      const seqs = await Promise.all(
        Array.from({ length: 50 }, async (_, i) => {
          await new Promise((r) => setTimeout(r, Math.random() * 20));
          const r = await store.enqueueOutbox('m', [{ msgId: `msg_${i}`, msg: { t: 'ping', at: i }, expiresAt }], new Date().toISOString());
          if (r === 'gone') throw new Error('machine unexpectedly gone');
          return r;
        }),
      );
      writing = false;
      await reader;
      expect(seqs.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      expect(new Set(seen).size).toBe(50);
      expect(seen).toHaveLength(50);
    } finally {
      await store.close();
      await pool.end();
      await db.drop();
    }
  });
});

describe('postgresHubStore tool-call claims on Postgres 16 (Review Focus #2)', () => {
  it('20 concurrent claimToolCall on one call: exactly one new, the rest running', async () => {
    const db = await freshDatabase();
    const pool = new pg.Pool({ connectionString: db.url, max: 20 });
    pool.on('error', () => undefined);
    const store = await postgresHubStore({ pool });
    try {
      const now = new Date().toISOString();
      const leaseUntil = new Date(Date.now() + 60_000).toISOString();
      const claims = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.claimToolCall(
            { id: `tcl_${i}`, callId: 'tc_1', sessionId: 's', runId: 'r', userId: 'u', machineId: 'm', tool: 'x', args: null, status: 'running', startedAt: now },
            { leaseUntil, now },
          ),
        ),
      );
      expect(claims.filter((c) => c.kind === 'new')).toHaveLength(1);
      expect(claims.filter((c) => c.kind === 'running')).toHaveLength(19);
      expect(await store.listToolCalls('s')).toHaveLength(1);
    } finally {
      await store.close();
      await pool.end();
      await db.drop();
    }
  });
});

describe('postgresHubStore survives a database connection drop', () => {
  it('idle pool connections terminated by the server: logged (no uncaught error), store keeps working', async () => {
    const db = await freshDatabase();
    const errors: string[] = [];
    const store = await postgresHubStore({ connectionString: db.url, onError: (e) => errors.push(e.message) });
    try {
      await Promise.all([store.listMachines('a'), store.listSessions('a'), store.getMachine('x')]); // open a few connections
      const name = new URL(db.url).pathname.slice(1);
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
      const start = Date.now();
      while (errors.length === 0 && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
      expect(errors.length).toBeGreaterThan(0); // vitest would also fail the run on an uncaught 'error'
      // A query racing the drop may still hit a dying connection once; the pool then recovers.
      let result: unknown;
      for (let i = 0; i < 5 && result === undefined; i++) result = await store.listMachines('a').catch(() => undefined);
      expect(result).toEqual([]);
    } finally {
      await store.close();
      await db.drop();
    }
  });
});

describe('redisCluster on Redis 7', () => {
  it('meets the ClusterAdapter contract', async () => {
    const keyPrefix = `t${randomBytes(4).toString('hex')}:`;
    await clusterContract(() => redisCluster({ url: inject('redisUrl'), keyPrefix }));
  });
});

describe('two hub nodes on real Redis + Postgres', () => {
  it('machine on A, browser on B: sessions, events, one approval, file pull, 8 MB upload', async () => {
    const db = await freshDatabase();
    const store = await postgresHubStore({ connectionString: db.url });
    const clusterA = redisCluster({ url: inject('redisUrl') });
    const clusterB = redisCluster({ url: inject('redisUrl') });
    try {
      await runMultiNodeScenario({ clusterA, clusterB, store });
    } finally {
      await clusterA.close();
      await clusterB.close();
      await store.close();
      await db.drop();
    }
  });
});

describe('postgresCluster on Postgres 16', () => {
  it('meets the ClusterAdapter contract (with the out-of-order commit case)', async () => {
    const db = await freshDatabase();
    const pool = new pg.Pool({ connectionString: db.url });
    pool.on('error', () => undefined);
    try {
      await clusterContract(() => postgresCluster({ connectionString: db.url }), {
        async insertUncommitted(channel, msg) {
          const tx = await pool.connect();
          await tx.query('BEGIN');
          await tx.query('INSERT INTO uncage_cluster_messages (channel, msg) VALUES ($1, $2)', [channel, msg]);
          return {
            async commit() {
              await tx.query('COMMIT');
              tx.release();
            },
          };
        },
      });
    } finally {
      await pool.end();
      await db.drop();
    }
  });

  it('delivers a message whose lower id commits after a higher id (Review Focus #1)', async () => {
    const db = await freshDatabase();
    const pool = new pg.Pool({ connectionString: db.url, max: 10 });
    pool.on('error', () => undefined);
    const a = postgresCluster({ pool });
    const b = postgresCluster({ pool });
    try {
      const got: string[] = [];
      await b.subscribe('c', (m) => got.push(m)); // creates the tables
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        await tx.query(`INSERT INTO uncage_cluster_messages (channel, msg) VALUES ('c', 'late')`);
        await a.publish('c', 'early');
        await until(() => got.includes('early'));
        await tx.query('COMMIT');
      } finally {
        tx.release();
      }
      await until(() => got.includes('late'), 2_000);
      expect(got).toEqual(['early', 'late']);
    } finally {
      await a.close();
      await b.close();
      await pool.end();
      await db.drop();
    }
  });

  it('a rolled-back id is skipped after gapTimeoutMs; later messages keep flowing', async () => {
    const db = await freshDatabase();
    const a = postgresCluster({ connectionString: db.url, gapTimeoutMs: 500 });
    const b = postgresCluster({ connectionString: db.url, gapTimeoutMs: 500 });
    const admin2 = new pg.Pool({ connectionString: db.url });
    admin2.on('error', () => undefined);
    try {
      const got: string[] = [];
      await b.subscribe('c', (m) => got.push(m));
      const tx = await admin2.connect();
      await tx.query('BEGIN');
      await tx.query(`INSERT INTO uncage_cluster_messages (channel, msg) VALUES ('c', 'never')`);
      await a.publish('c', 'one');
      await until(() => got.includes('one'));
      await tx.query('ROLLBACK');
      tx.release();
      await new Promise((r) => setTimeout(r, 1_000));
      for (let i = 0; i < 5; i++) await a.publish('c', `n${i}`);
      await until(() => got.length === 6, 3_000);
      expect(got).toEqual(['one', 'n0', 'n1', 'n2', 'n3', 'n4']);
    } finally {
      await a.close();
      await b.close();
      await admin2.end();
      await db.drop();
    }
  });

  it('a message committing after gapTimeoutMs is dropped and reported once through onError', async () => {
    const db = await freshDatabase();
    const pool = new pg.Pool({ connectionString: db.url, max: 10 });
    pool.on('error', () => undefined);
    const errors: string[] = [];
    const a = postgresCluster({ pool });
    const b = postgresCluster({ pool, gapTimeoutMs: 300, onError: (e) => errors.push(e.message) });
    try {
      const got: string[] = [];
      await b.subscribe('c', (m) => got.push(m));
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        await tx.query(`INSERT INTO uncage_cluster_messages (channel, msg) VALUES ('c', 'late')`);
        await a.publish('c', 'early');
        await until(() => got.includes('early'));
        await new Promise((r) => setTimeout(r, 800)); // past gapTimeoutMs
        await tx.query('COMMIT');
      } finally {
        tx.release();
      }
      await until(() => errors.length > 0, 5_000);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/late commit after gapTimeoutMs.*message dropped/);
      expect(got).toEqual(['early']);
    } finally {
      await a.close();
      await b.close();
      await pool.end();
      await db.drop();
    }
  });

  it('50 concurrent publishers from 5 instances: each subscriber gets every message exactly once', async () => {
    const db = await freshDatabase();
    const nodes = Array.from({ length: 5 }, () => postgresCluster({ connectionString: db.url }));
    try {
      const got = nodes.map(() => [] as string[]);
      await Promise.all(nodes.map((n, i) => n.subscribe('c', (m) => got[i]!.push(m))));
      await Promise.all(
        Array.from({ length: 50 }, async (_, i) => {
          await new Promise((r) => setTimeout(r, Math.random() * 30));
          await nodes[i % 5]!.publish('c', `m${i}`);
        }),
      );
      await until(() => got.every((g) => g.length >= 50), 5_000);
      await new Promise((r) => setTimeout(r, 500));
      for (const g of got) expect([...g].sort()).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`).sort());
    } finally {
      await Promise.all(nodes.map((n) => n.close()));
      await db.drop();
    }
  });
});

describe('two hub nodes sharing one Postgres (postgresHubStore + postgresCluster, no Redis)', () => {
  it('machine on A, browser on B: presence across nodes, commands, events, one approval, file pull, 8 MB upload', async () => {
    const db = await freshDatabase();
    const store = await postgresHubStore({ connectionString: db.url });
    const clusterA = postgresCluster({ connectionString: db.url });
    const clusterB = postgresCluster({ connectionString: db.url });
    try {
      await runMultiNodeScenario({ clusterA, clusterB, store });
    } finally {
      await clusterA.close();
      await clusterB.close();
      await store.close();
      await db.drop();
    }
  }, 60_000);
});

/**
 * A transaction-mode pooler (PgBouncer, Neon's -pooler host) in miniature: a "client" from
 * `connect()` is pinned to one server connection only between BEGIN and COMMIT/ROLLBACK; every
 * other statement goes to whichever pooled connection is free.
 */
function transactionPooled(pool: pg.Pool): import('./store/postgres.js').PgPoolLike {
  return {
    query: (sql, params) => pool.query(sql, params),
    end: async () => undefined,
    async connect() {
      let pinned: pg.PoolClient | undefined;
      return {
        async query(sql: string, params?: unknown[]) {
          if (!pinned && /^BEGIN\b/i.test(sql)) pinned = await pool.connect();
          if (!pinned) {
            // Outside a transaction: a different server connection than the last statement's.
            const other = await pool.connect();
            const hold = await pool.connect();
            try {
              return await other.query(sql, params);
            } finally {
              other.release();
              hold.release();
            }
          }
          const c = pinned;
          try {
            return await c.query(sql, params);
          } finally {
            if (/^(COMMIT|ROLLBACK)\b/i.test(sql)) {
              pinned = undefined;
              c.release();
            }
          }
        },
        release() {
          pinned?.release();
          pinned = undefined;
        },
      };
    },
  };
}

describe('postgresHubStore behind a transaction-mode pooler', () => {
  it('migrates without leaving an advisory lock behind; concurrent starts on a fresh database succeed', async () => {
    const db = await freshDatabase();
    const pool = new pg.Pool({ connectionString: db.url, max: 6 });
    pool.on('error', () => undefined);
    try {
      const stores = await Promise.all([1, 2, 3].map(() => postgresHubStore({ pool: transactionPooled(pool) })));
      // A session lock taken on one connection and "released" on another would still be held here.
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted");
      expect(rows[0].n).toBe(0);
      const ids = await pool.query('SELECT id FROM uncage_hub_migrations ORDER BY id');
      expect(ids.rows.length).toBeGreaterThan(0);
      await Promise.all(stores.map((s) => s.close()));
    } finally {
      await pool.end();
      await db.drop();
    }
  });
});

describe('three hub instances sharing one Postgres (FaaS mode, no Redis)', () => {
  it('FaaS scenario: postgresCluster + postgresHubStore on Postgres 16, 3 instances', async () => {
    const db = await freshDatabase();
    const pools: pg.Pool[] = [];
    let clusterPolls = 0;
    const isPoll = (sql: string) => /^\s*SELECT\b/i.test(sql) && sql.includes('uncage_cluster_messages') && sql.includes('id >');
    const t0 = Date.now();
    try {
      await runFaasScenario({
        // Every instance: its own pools, like separate function instances.
        makeStore: () => postgresHubStore({ connectionString: db.url }),
        makeCluster: () => {
          const pool = new pg.Pool({ connectionString: db.url, max: 5 });
          pool.on('error', () => undefined);
          pools.push(pool);
          return postgresCluster({
            pool: {
              query: (sql: string, params?: unknown[]) => {
                if (isPoll(sql)) clusterPolls++;
                return pool.query(sql, params);
              },
              connect: () => pool.connect(),
              end: async () => undefined,
            } as never,
          });
        },
        streamMaxMs: 800,
      });
      const elapsedS = (Date.now() - t0) / 1000;
      console.info(`[faas-scenario] cluster poll queries: ${clusterPolls} in ${elapsedS.toFixed(1)} s across 3 instances while active (${(clusterPolls / elapsedS / 3).toFixed(1)}/s per instance)`);
    } finally {
      await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
      await db.drop();
    }
  }, 120_000);

  it('adaptive polling: queries per second per instance, idle vs active', async () => {
    const db = await freshDatabase();
    const pool = new pg.Pool({ connectionString: db.url, max: 5 });
    pool.on('error', () => undefined);
    let polls = 0;
    const counting = {
      query: (sql: string, params?: unknown[]) => {
        if (/^\s*SELECT\b/i.test(sql) && sql.includes('uncage_cluster_messages') && sql.includes('id >')) polls++;
        return pool.query(sql, params);
      },
      connect: () => pool.connect(),
      end: async () => undefined,
    } as never;
    const a = postgresCluster({ pool: counting, activeWindowMs: 2_000 });
    const b = postgresCluster({ connectionString: db.url });
    try {
      await a.subscribe('ch', () => undefined);
      await new Promise((r) => setTimeout(r, 6_000)); // quiet: the interval has backed off to idlePollMs
      let before = polls;
      await new Promise((r) => setTimeout(r, 6_000));
      const idle = (polls - before) / 6;
      const remote = setInterval(() => void b.publish('ch', 'x'), 50);
      await new Promise((r) => setTimeout(r, 1_000));
      before = polls;
      await new Promise((r) => setTimeout(r, 3_000));
      const active = (polls - before) / 3;
      clearInterval(remote);
      console.info(`[faas-scenario] cluster poll queries per instance: idle ${idle.toFixed(2)}/s, active ${active.toFixed(2)}/s`);
      expect(idle).toBeLessThan(1);
      expect(active).toBeGreaterThan(idle * 3);
    } finally {
      await a.close();
      await b.close();
      await pool.end();
      await db.drop();
    }
  }, 60_000);
});
