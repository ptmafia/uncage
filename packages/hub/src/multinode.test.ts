import RedisMock from 'ioredis-mock';
import { afterEach, describe, it } from 'vitest';
import { memoryCluster } from './cluster/memory.js';
import { redisCluster, type RedisLike } from './cluster/redis.js';
import { runMultiNodeScenario } from './multinode-scenario.js';
import { pgliteHubStore } from './node/index.js';
import { clusterContract } from './cluster/contract.js';

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
});

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
});
