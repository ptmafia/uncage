import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Attachment, Session } from '@uncage/protocol';
import RedisMock from 'ioredis-mock';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClusterAdapter } from './cluster/cluster.js';
import { memoryCluster } from './cluster/memory.js';
import { redisCluster, type RedisLike } from './cluster/redis.js';
import { nodeChannel } from './machines.js';
import { watchPoolErrors } from './store/postgres.js';
import { connectFakeAgent, fakeMachine, sleep, startTestHub, until, uploadReceiver, type FakeAgent, type TestHub } from './test-utils.js';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c().catch(() => undefined);
});

async function hubWithMachine(cluster: ClusterAdapter, o: Parameters<typeof startTestHub>[0] = {}) {
  const t: TestHub = await startTestHub({ cluster, ...o });
  closers.push(() => t.close());
  const fm = fakeMachine();
  const up = uploadReceiver();
  const { machineToken, machineId } = await t.pair('alice');
  const a: FakeAgent = await connectFakeAgent({ url: t.wsUrl, token: machineToken, onCommand: fm.handler, onFrame: up.onFrame });
  closers.push(() => a.close());
  const node = (await until(() => cluster.getPresence(machineId)))!;
  return { t, a, up, machineId, node };
}

describe('cluster messages are validated', () => {
  it('forwards only attachment_* frames whose id is the upload id; drops malformed messages', async () => {
    const cluster = memoryCluster();
    closers.push(() => cluster.close());
    const { a, machineId, node } = await hubWithMachine(cluster);
    const pub = (m: unknown) => cluster.publish(nodeChannel(node), JSON.stringify(m));
    // A forged command smuggled as an upload frame, and an upload frame for another id.
    await pub({ k: 'up', id: 'u1', from: 'node_x', machineId, frame: { t: 'command', id: 'u1', op: 'listSessions', args: {} } });
    await pub({ k: 'up', id: 'u1', from: 'node_x', machineId, frame: { t: 'attachment_begin', id: 'u2', sessionId: 's', name: 'a.txt', mime: 'text/plain', size: 1 } });
    await pub({ k: 'cmd', id: 'c1' }); // malformed
    await pub('not an object');
    await sleep(100);
    expect(a.frames.filter((f) => f.t === 'command' || f.t.startsWith('attachment_'))).toEqual([]);
    // Positive control: a well-formed upload frame is forwarded.
    await pub({ k: 'up', id: 'u3', from: 'node_x', machineId, frame: { t: 'attachment_begin', id: 'u3', sessionId: 's', name: 'a.txt', mime: 'text/plain', size: 1 } });
    await a.waitFor((f) => f.t === 'attachment_begin' && f.id === 'u3');
  });
});

describe('cross-node upload timeout', () => {
  it('re-arms after each chunk: a slow but steady upload longer than commandTimeoutMs succeeds', async () => {
    const inner = memoryCluster();
    // Every chunk takes 25 ms to publish: 8 MB = 32 chunks ≈ 0.8 s, longer than the 300 ms timeout.
    const cluster: ClusterAdapter = {
      ...inner,
      publish: async (ch, msg) => {
        if (msg.includes('"attachment_chunk"')) await sleep(25);
        return inner.publish(ch, msg);
      },
    };
    closers.push(() => inner.close());
    const { t } = await hubWithMachine(cluster, { commandTimeoutMs: 300 });
    const s = (await (await t.as('alice', '/sessions', { method: 'POST', body: JSON.stringify({ runtime: 'fake' }) })).json()) as Session;
    const data = Buffer.alloc(8 * 1024 * 1024, 3);
    const res = await t.as('alice', `/sessions/${s.id}/attachments`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-filename': 'a.pdf' }, body: data });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Attachment).sha256).toBe(createHash('sha256').update(data).digest('hex'));
  });
});

describe('redisCluster keyPrefix', () => {
  it('prefixes channel names too: clusters with different prefixes do not hear each other', async () => {
    const redis = new RedisMock() as unknown as RedisLike;
    const raw = new RedisMock() as unknown as RedisLike;
    const p1 = redisCluster({ client: redis, keyPrefix: 'p1:' });
    const p2 = redisCluster({ client: redis, keyPrefix: 'p2:' });
    closers.push(() => p1.close(), () => p2.close());
    const got: string[] = [];
    await p1.subscribe('ch', (m) => got.push(`p1:${m}`));
    await p2.subscribe('ch', (m) => got.push(`p2:${m}`));
    await p1.publish('ch', 'a');
    await raw.publish('ch', 'unprefixed');
    await raw.publish('p2:ch', 'b');
    await until(() => got.length >= 2);
    await sleep(50);
    expect(got.sort()).toEqual(['p1:a', 'p2:b']);
  });
});

describe('connection error listeners', () => {
  it('a pool error is logged, not thrown (failover must not crash the node)', () => {
    const pool = new EventEmitter();
    const seen: string[] = [];
    watchPoolErrors(pool as never, (e) => seen.push(e.message));
    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    expect(seen).toEqual(['terminating connection due to administrator command']);
    const quiet = new EventEmitter();
    watchPoolErrors(quiet as never, () => {
      throw new Error('logger broke');
    });
    expect(() => quiet.emit('error', new Error('x'))).not.toThrow();
  });

  it('redisCluster attaches an error listener to the subscriber connection it creates', async () => {
    const redis = new RedisMock() as unknown as RedisLike & { duplicate(): RedisLike };
    let dup: (RedisLike & EventEmitter) | undefined;
    const orig = redis.duplicate.bind(redis);
    redis.duplicate = () => (dup = orig() as RedisLike & EventEmitter);
    const errors: string[] = [];
    const c = redisCluster({ client: redis, onError: (e) => errors.push(e.message) });
    closers.push(() => c.close());
    await c.subscribe('ch', () => undefined);
    expect(() => dup!.emit('error', new Error('ECONNRESET'))).not.toThrow();
    expect(errors).toEqual(['ECONNRESET']);
  });
});
