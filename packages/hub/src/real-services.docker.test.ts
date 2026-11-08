/** Real Redis + real Postgres (containers from docker-setup.ts). Runs only with UNCAGE_DOCKER_TESTS=1. */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { clusterContract } from './cluster/contract.js';
import { redisCluster } from './cluster/redis.js';
import { runMultiNodeScenario } from './multinode-scenario.js';
import { hubStoreContract } from './store/contract.js';
import { postgresHubStore } from './store/postgres.js';

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
