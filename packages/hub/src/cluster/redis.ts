import type { ClusterAdapter } from './cluster.js';

/**
 * The slice of an ioredis client the adapter uses (`new Redis(...)` from ioredis 5 or 6
 * satisfies it; so does `ioredis-mock`).
 */
export interface RedisLike {
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  /** A new connection with the same options (pub/sub needs a dedicated one). */
  duplicate(): RedisLike;
  quit(): Promise<unknown>;
}

/** Deletes the presence key only if it still names this node. */
const CLEAR_IF_OWNER = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Cluster adapter on Redis, for running several hub nodes behind a load balancer: commands and
 * session events travel over Redis pub/sub (in publish order per connection), machine presence is
 * a `SET … EX` key per machine (`<keyPrefix>presence:<machineId>`).
 *
 * - `{ url }`: the adapter connects with `ioredis` (install it) and closes its connections on
 *   `close()`.
 * - `{ client }`: your ioredis client; it is used for publishing and presence and left open on
 *   `close()`. The adapter subscribes on its own `client.duplicate()` connection, which it closes.
 *
 * Every node must use the same Redis (and `keyPrefix`). Rate limits are not shared through the
 * cluster: each node counts on its own.
 *
 * @example
 * const cluster = redisCluster({ url: process.env.REDIS_URL! });
 */
export function redisCluster(o: ({ url: string } | { client: RedisLike }) & { keyPrefix?: string }): ClusterAdapter {
  const prefix = o.keyPrefix ?? 'uncage:';
  const owned = 'url' in o;
  const pub: Promise<RedisLike> =
    'client' in o
      ? Promise.resolve(o.client)
      : import('ioredis').then(
          (m) => {
            const Redis = ((m as unknown as { default?: unknown }).default ?? (m as unknown as { Redis: unknown }).Redis) as new (url: string) => RedisLike;
            return new Redis(o.url);
          },
          (e: unknown) => {
            throw new Error('redisCluster({ url }) needs the "ioredis" package: npm install ioredis', { cause: e });
          },
        );
  // Avoid an unhandled rejection before the first call awaits it.
  pub.catch(() => undefined);

  const handlers = new Map<string, Set<(msg: string) => void>>();
  /** Per channel: resolves once Redis confirmed the SUBSCRIBE. */
  const active = new Map<string, Promise<unknown>>();
  let sub: Promise<RedisLike> | undefined;
  const subscriber = (): Promise<RedisLike> =>
    (sub ??= pub.then((p) => {
      const s = p.duplicate();
      s.on('message', (channel, message) => {
        for (const fn of [...(handlers.get(channel) ?? [])]) {
          try {
            fn(message);
          } catch {
            // a subscriber's error must not break delivery to the others
          }
        }
      });
      return s;
    }));
  const key = (machineId: string) => `${prefix}presence:${machineId}`;
  let closed = false;

  return {
    async publish(channel, msg) {
      await (await pub).publish(channel, msg);
    },
    async subscribe(channel, fn) {
      const s = await subscriber();
      let set = handlers.get(channel);
      const first = !set;
      if (!set) handlers.set(channel, (set = new Set()));
      const wrapped = (msg: string) => fn(msg);
      set.add(wrapped);
      if (first) active.set(channel, s.subscribe(channel));
      try {
        await active.get(channel);
      } catch (e) {
        set.delete(wrapped);
        if (set.size === 0 && handlers.get(channel) === set) {
          handlers.delete(channel);
          active.delete(channel);
        }
        throw e;
      }
      return () => {
        set.delete(wrapped);
        if (set.size === 0 && handlers.get(channel) === set) {
          handlers.delete(channel);
          active.delete(channel);
          if (!closed) void s.unsubscribe(channel).catch(() => undefined);
        }
      };
    },
    async setPresence(machineId, nodeId, ttlSec) {
      await (await pub).set(key(machineId), nodeId, 'EX', Math.max(1, Math.ceil(ttlSec)));
    },
    async getPresence(machineId) {
      return (await pub).get(key(machineId));
    },
    async clearPresence(machineId, nodeId) {
      await (await pub).eval(CLEAR_IF_OWNER, 1, key(machineId), nodeId);
    },
    async close() {
      if (closed) return;
      closed = true;
      handlers.clear();
      if (sub) await (await sub).quit().catch(() => undefined);
      if (owned) await (await pub).quit().catch(() => undefined);
    },
  };
}
