import { PGlite } from '@electric-sql/pglite';
import RedisMock from 'ioredis-mock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryCluster } from './cluster/memory.js';
import { sqlCluster } from './cluster/postgres.js';
import type { SqlClient } from './store/sql.js';
import { redisCluster, type RedisLike } from './cluster/redis.js';
import { runFaasScenario } from './faas-scenario.js';
import { runMultiNodeScenario } from './multinode-scenario.js';
import { pgliteHubStore } from './node/index.js';
import { clusterContract } from './cluster/contract.js';
import { until } from './test-utils.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c().catch(() => undefined);
});

describe('two hub nodes (machine on A, browser on B)', () => {
  it('ioredis-mock cluster + one shared PGlite store: sessions, events, one approval, file pull, 8 MB upload', async () => {
    const redis = new RedisMock() as unknown as RedisLike;
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    const clusterA = redisCluster({ client: redis });
    const clusterB = redisCluster({ client: redis });
    closers.push(() => store.close(), () => clusterA.close(), () => clusterB.close());
    await runMultiNodeScenario({ clusterA, clusterB, store });
  }, 30_000);

  it('the same scenario over one shared memoryCluster', async () => {
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    const cluster = memoryCluster();
    closers.push(() => store.close(), () => cluster.close());
    await runMultiNodeScenario({ clusterA: cluster, clusterB: cluster, store });
  }, 30_000);

  it('two-node scenario over sqlCluster (one shared PGlite) + PGlite store', async () => {
    const db = await sharedPglite();
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    const clusterA = sqlCluster(db);
    const clusterB = sqlCluster(db);
    closers.push(() => store.close(), () => clusterA.close(), () => clusterB.close());
    await runMultiNodeScenario({ clusterA, clusterB, store });
  }, 30_000);
});

describe('FaaS mode, three instances', () => {
  it('FaaS scenario: sqlCluster + one PGlite store (in-process)', async () => {
    // PGlite has one connection: every instance shares the one database through the same client.
    const db = await sharedPglite();
    const store = await pgliteHubStore({ dataDir: 'memory://' });
    await runFaasScenario({ makeStore: async () => store, makeCluster: () => sqlCluster(db, { activePollMs: 30, idlePollMs: 150 }), streamMaxMs: 400 });
  }, 90_000);
});

/** A fresh in-memory PGlite as a `SqlClient`, closed after the test. */
async function sharedPglite(): Promise<SqlClient> {
  const pg = new PGlite('memory://');
  await pg.waitReady;
  closers.push(() => pg.close());
  return pg as unknown as SqlClient;
}

/** Counts the poll queries (`SELECT … FROM uncage_cluster_messages WHERE id > …`) sent to `db`. */
function countingPolls(db: SqlClient): { db: SqlClient; polls: () => number } {
  let n = 0;
  const isPoll = (sql: string) => /^\s*SELECT\b/i.test(sql) && sql.includes('uncage_cluster_messages') && sql.includes('id >');
  return {
    polls: () => n,
    db: {
      query: (sql, params) => {
        if (isPoll(sql)) n++;
        return db.query(sql, params);
      },
      transaction: (fn) => db.transaction(fn),
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ClusterAdapter contract', () => {
  it('memoryCluster (one shared instance)', async () => {
    const m = memoryCluster();
    const shared = { ...m, close: async () => undefined };
    await clusterContract(() => shared);
    await m.close();
  });

  it('redisCluster over ioredis-mock', async () => {
    const redis = new RedisMock() as unknown as RedisLike;
    await clusterContract(() => redisCluster({ client: redis }));
  });

  it('sqlCluster on one PGlite meets the ClusterAdapter contract', async () => {
    const db = await sharedPglite();
    await clusterContract(() => sqlCluster(db));
  });
});

describe('sqlCluster', () => {
  it('backs off to idlePollMs when quiet and returns to activePollMs on traffic', async () => {
    const db = await sharedPglite();
    const counted = countingPolls(db);
    const a = sqlCluster(counted.db, { activeWindowMs: 300 });
    const b = sqlCluster(db);
    closers.push(() => a.close(), () => b.close());
    const got: string[] = [];
    await a.subscribe('ch', (m) => got.push(m));
    await sleep(3_500); // the interval has doubled up to idlePollMs (2 s) by now

    let before = counted.polls();
    await sleep(3_000);
    expect(counted.polls() - before).toBeLessThanOrEqual(3); // 1–2 at 2 s

    // Traffic from another instance: back to activePollMs (300 ms) once the first message arrives.
    const remote = setInterval(() => void b.publish('ch', 'remote'), 50);
    try {
      await until(() => got.includes('remote'), 5_000);
      before = counted.polls();
      await sleep(2_000);
      expect(counted.polls() - before).toBeGreaterThanOrEqual(4); // ~6–7 at 300 ms; idle would be 1
    } finally {
      clearInterval(remote);
    }

    // Local publishes poll immediately.
    before = counted.polls();
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      await a.publish('ch', `local${i}`);
      await sleep(100);
    }
    const perSec = ((counted.polls() - before) * 1000) / (Date.now() - t0);
    expect(perSec).toBeGreaterThanOrEqual(5); // ~10: one per publish
    await until(() => got.includes('local9'), 2_000);
  }, 30_000);

  it('a message published right after subscribe resolves is delivered; earlier ones are not', async () => {
    const db = await sharedPglite();
    const a = sqlCluster(db);
    const b = sqlCluster(db);
    closers.push(() => a.close(), () => b.close());
    await a.publish('ch', 'before');
    const got: string[] = [];
    await b.subscribe('ch', (m) => got.push(m));
    await a.publish('ch', 'after');
    await until(() => got.length > 0, 2_000);
    await sleep(400);
    expect(got).toEqual(['after']);
  });

  it('keeps per-instance publish order when publishes are not awaited', async () => {
    const db = await sharedPglite();
    const a = sqlCluster(db);
    const b = sqlCluster(db);
    closers.push(() => a.close(), () => b.close());
    const got: string[] = [];
    await b.subscribe('ch', (m) => got.push(m));
    const sent = Array.from({ length: 50 }, (_, i) => `m${i}`);
    await Promise.all(sent.map((m) => a.publish('ch', m)));
    await until(() => got.length === 50, 3_000);
    expect(got).toEqual(sent);
  });

  it('deletes messages older than retentionMs and expired presence rows', async () => {
    const db = await sharedPglite();
    vi.spyOn(Math, 'random').mockReturnValue(1); // first prune due right away (it is jittered over 30 s)
    const a = sqlCluster(db);
    vi.restoreAllMocks();
    closers.push(() => a.close());
    await a.getPresence('nobody'); // migrates
    await db.query(`INSERT INTO uncage_cluster_messages (channel, msg, created_at) VALUES ('ch', 'old', now() - interval '2 minutes')`);
    await db.query(`INSERT INTO uncage_cluster_presence (machine_id, node_id, expires_at) VALUES ('m1', 'n1', now() - interval '1 second')`);
    await a.setPresence('m2', 'n2', 30);
    await a.publish('ch', 'new'); // a due prune runs after a publish (or poll), then every 30 s
    await until(async () => {
      const { rows } = await db.query<{ msg: string }>('SELECT msg FROM uncage_cluster_messages');
      return rows.length === 1 && rows[0]!.msg === 'new';
    }, 2_000);
    const { rows } = await db.query<{ machine_id: string }>('SELECT machine_id FROM uncage_cluster_presence');
    expect(rows.map((r) => r.machine_id)).toEqual(['m2']);
  });

  it('subscribe after close rejects; close stops polling', async () => {
    const db = await sharedPglite();
    const counted = countingPolls(db);
    const a = sqlCluster(counted.db);
    await a.subscribe('ch', () => undefined);
    await a.close();
    const n = counted.polls();
    await sleep(700);
    expect(counted.polls()).toBe(n);
    await expect(a.subscribe('ch', () => undefined)).rejects.toThrow(/closed/);
    await expect(a.publish('ch', 'x')).rejects.toThrow(/closed/);
    await expect(a.setPresence('m', 'n', 30)).rejects.toThrow(/closed/);
    await expect(a.getPresence('m')).rejects.toThrow(/closed/);
    await expect(a.clearPresence('m', 'n')).rejects.toThrow(/closed/);
  });

  it('a new subscription on an idle loop polls right away (no wait of up to idlePollMs)', async () => {
    const db = await sharedPglite();
    const counted = countingPolls(db);
    const a = sqlCluster(counted.db, { activeWindowMs: 100 });
    const b = sqlCluster(db);
    closers.push(() => a.close(), () => b.close());
    await a.subscribe('x', () => undefined);
    await sleep(4_500); // the loop now sleeps 2 s between polls
    const n = counted.polls();
    await until(() => counted.polls() > n, 3_000); // just polled: the next poll is ~2 s away
    const got: string[] = [];
    await a.subscribe('y', (m) => got.push(m));
    const t0 = Date.now();
    await b.publish('y', 'hello');
    await until(() => got.includes('hello'), 3_000);
    expect(Date.now() - t0).toBeLessThan(1_200); // ~300 ms; without the kick up to 2 s
  }, 15_000);

  it('a skipped id that commits after gapTimeoutMs is reported once through onError', async () => {
    const db = await sharedPglite();
    const errors: string[] = [];
    const a = sqlCluster(db, { gapTimeoutMs: 200, onError: (e) => errors.push(e.message) });
    closers.push(() => a.close());
    const got: string[] = [];
    await a.subscribe('ch', (m) => got.push(m));
    // A publish that took an id but has not committed (PGlite has one connection: burn the id and
    // insert it explicitly later).
    const { rows } = await db.query<{ id: string }>(`SELECT nextval('uncage_cluster_messages_id_seq')::text AS id`);
    await a.publish('ch', 'early');
    await until(() => got.includes('early'), 2_000);
    await sleep(600); // past gapTimeoutMs: skipped
    await db.query(`INSERT INTO uncage_cluster_messages (id, channel, msg) VALUES ($1::bigint, 'ch', 'late')`, [rows[0]!.id]);
    await until(() => errors.length > 0, 5_000); // re-checked ~5 × gapTimeoutMs after the skip
    await sleep(1_500);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/late commit after gapTimeoutMs.*message dropped/);
    expect(got).toEqual(['early']);
  }, 15_000);
});
