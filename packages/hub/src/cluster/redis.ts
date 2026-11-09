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
  on(event: 'error', listener: (err: Error) => void): unknown;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  /** A new connection with the same options (pub/sub needs a dedicated one). */
  duplicate(): RedisLike;
  quit(): Promise<unknown>;
}

/** Sets (and refreshes the expiry of) the presence key unless another node holds it. */
const REFRESH_IF_FREE_OR_OWNER =
  "local v = redis.call('get', KEYS[1]) if v == false or v == ARGV[1] then redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2]) return 1 else return 0 end";
/** Deletes the presence key only if it still names this node. */
const CLEAR_IF_OWNER = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Cluster adapter on Redis, for running several hub nodes behind a load balancer: commands and
 * session events travel over Redis pub/sub (in publish order per connection; channel names are
 * prefixed with `keyPrefix` too), machine presence is a `SET … EX` key per machine
 * (`<keyPrefix>presence:<machineId>`).
 *
 * - `{ url }`: the adapter connects with `ioredis` (install it) and closes its connections on
 *   `close()`.
 * - `{ client }`: your ioredis client; it is used for publishing and presence and left open on
 *   `close()`. Attach your own `'error'` listener to it. The adapter subscribes on its own
 *   `client.duplicate()` connection, which it closes.
 *
 * Connection errors on the connections the adapter owns go to `onError` (default: `console.error`)
 * instead of crashing the process; ioredis reconnects by itself.
 *
 * Every node must use the same Redis (and `keyPrefix`). Rate limits do not use the cluster: they
 * are counted in the hub store, which every node shares.
 *
 * @example
 * const cluster = redisCluster({ url: process.env.REDIS_URL! });
 */
export function redisCluster(
  o: ({ url: string } | { client: RedisLike }) & { keyPrefix?: string; onError?: (err: Error) => void },
): ClusterAdapter {
  const prefix = o.keyPrefix ?? 'uncage:';
  const onError = o.onError ?? ((err: Error) => console.error('[uncage] redis cluster connection error:', err.message));
  const owned = 'url' in o;
  const pub: Promise<RedisLike> =
    'client' in o
      ? Promise.resolve(o.client)
      : import(/* webpackIgnore: true */ 'ioredis').then(
          (m) => {
            const Redis = ((m as unknown as { default?: unknown }).default ?? (m as unknown as { Redis: unknown }).Redis) as new (url: string) => RedisLike;
            const client = new Redis(o.url);
            client.on('error', onError);
            return client;
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
      s.on('error', onError);
      s.on('message', (channel, message) => {
        if (!channel.startsWith(prefix)) return;
        for (const fn of [...(handlers.get(channel.slice(prefix.length)) ?? [])]) {
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
      await (await pub).publish(prefix + channel, msg);
    },
    async subscribe(channel, fn) {
      const s = await subscriber();
      let set = handlers.get(channel);
      const first = !set;
      if (!set) handlers.set(channel, (set = new Set()));
      const wrapped = (msg: string) => fn(msg);
      set.add(wrapped);
      if (first) active.set(channel, s.subscribe(prefix + channel));
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
          if (!closed) void s.unsubscribe(prefix + channel).catch(() => undefined);
        }
      };
    },
    async setPresence(machineId, nodeId, ttlSec) {
      await (await pub).set(key(machineId), nodeId, 'EX', Math.max(1, Math.ceil(ttlSec)));
    },
    async refreshPresence(machineId, nodeId, ttlSec) {
      return Number(await (await pub).eval(REFRESH_IF_FREE_OR_OWNER, 1, key(machineId), nodeId, Math.max(1, Math.ceil(ttlSec)))) === 1;
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
