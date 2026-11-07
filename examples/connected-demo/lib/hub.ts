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
    // Behind scripts/multinode.ts's proxy every request comes from 127.0.0.1; the proxy appends the
    // real client to X-Forwarded-For, so per-IP rate limits use its rightmost entry instead.
    ...(env.TRUST_PROXY === '1' ? { rateLimits: { clientIp: forwardedClient } } : {}),
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

/** Rightmost `X-Forwarded-For` entry: the address our own proxy saw. */
export function forwardedClient(req: Request): string | undefined {
  const last = req.headers.get('x-forwarded-for')?.split(',').pop()?.trim();
  return last || undefined;
}
