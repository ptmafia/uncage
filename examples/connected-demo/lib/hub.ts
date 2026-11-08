/**
 * Builds this website's Uncage hub. Single node (default): embedded PGlite under the data dir and
 * an in-memory cluster. With `DATABASE_URL` / `REDIS_URL` set: shared Postgres + Redis, so several
 * nodes can run behind a load balancer (see scripts/multinode.ts).
 */
import { join } from 'node:path';
import { createHub, pgliteHubStore, postgresHubStore, redisCluster, type Hub } from '@uncage/hub';
import { userFromRequest } from './auth.ts';
import { dataDir, publicUrl } from './config.ts';
import { demoSkills } from './skills.ts';
import { demoTools } from './tools.ts';

export async function createDemoHub(env: NodeJS.ProcessEnv = process.env): Promise<{ hub: Hub; close(): Promise<void> }> {
  const store = env.DATABASE_URL
    ? await postgresHubStore({ connectionString: env.DATABASE_URL })
    : await pgliteHubStore({ dataDir: join(dataDir(env), 'hub') });
  const cluster = env.REDIS_URL ? redisCluster({ url: env.REDIS_URL }) : undefined;
  const hub = await createHub({
    publicUrl: publicUrl(env),
    getUser: async (req) => userFromRequest(req),
    store,
    ...(cluster ? { cluster } : {}),
    tools: demoTools,
    skills: demoSkills,
    // The website keeps a replica of every conversation: history stays visible with the machine off.
    sessionStorage: 'site',
    site: { name: 'Uncage Connected Demo' },
    // Per-IP rate limits behind a proxy: see clientIpResolver.
    ...withClientIp(clientIpResolver(env)),
  });
  return {
    hub,
    // The hub only closes a store / cluster it created itself.
    close: async () => {
      await hub.close();
      await cluster?.close();
      await store.close();
    },
  };
}

function withClientIp(clientIp: ((req: Request) => string | undefined) | undefined) {
  return clientIp ? { rateLimits: { clientIp } } : {};
}

/**
 * How per-IP rate limits find the client. Unset (plain `docker run`, no proxy): the socket address.
 * `TRUST_PROXY=1`: the rightmost `X-Forwarded-For` entry, for a proxy that sets it (Railway's edge
 * overwrites the header; scripts/multinode.ts's proxy appends to it). `CLIENT_IP_HEADER=<name>`
 * (for example `x-real-ip` on Railway, `cf-connecting-ip` behind Cloudflare) reads that header
 * instead and takes precedence. Only set either when every request really comes through that proxy:
 * otherwise clients can choose their own rate-limit key.
 */
export function clientIpResolver(env: Record<string, string | undefined> = process.env): ((req: Request) => string | undefined) | undefined {
  const header = env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (header) return (req) => req.headers.get(header)?.trim() || undefined;
  if (env.TRUST_PROXY === '1') return forwardedClient;
  return undefined;
}

/** Rightmost `X-Forwarded-For` entry: the address our own proxy saw. */
export function forwardedClient(req: Request): string | undefined {
  const last = req.headers.get('x-forwarded-for')?.split(',').pop()?.trim();
  return last || undefined;
}
