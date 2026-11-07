/** Real Redis + real Postgres (containers from docker-setup.ts). Runs only with UNCAGE_DOCKER_TESTS=1. */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, inject, it } from 'vitest';
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
