/**
 * Builds this website's Uncage hub, for either entry (lib/mode.ts):
 *
 * - `traditional` (server.ts): single node by default — embedded PGlite under the data dir and an
 *   in-memory cluster. With `DATABASE_URL` / `REDIS_URL`: shared Postgres + Redis, so several nodes
 *   can run behind a load balancer (see scripts/multinode.ts). server.ts adds the WebSocket server.
 * - `faas` (the route handler under `next start` / Vercel): Postgres only (`DATABASE_URL`, required
 *   with `DEMO_SECRET`; one shared pool, lib/db.ts), cluster messages through Postgres unless
 *   `REDIS_URL` is set, streams that end before the platform's function time limit, and the public
 *   demo's 24 h asset purge run by the hub's maintenance (opportunistic, or Vercel Cron on `/api/uncage/maintenance`).
 *
 * Both get the same tools, skills, sign-in and options otherwise.
 */
import { join } from 'node:path';
import { createHub, expoPushNotifier, postgresCluster, postgresHubStore, redisCluster, type ClusterAdapter, type Hub, type HubOptions, type HubStore, type OnAttention } from '@uncage/hub';
import { assetStore } from './assets.ts';
import { endSharedPool, sharedPool } from './db.ts';
import { userFromRequest } from './auth.ts';
import { dataDir, isPublicDemo, publicUrl } from './config.ts';
import { requireFaasEnv, type DemoMode } from './mode.ts';
import { PUSH_TOKEN_MAX_AGE_MS, pushTokenStore } from './push-tokens.ts';
import { demoSkills } from './skills.ts';
import { demoTools } from './tools.ts';

/** Public demo: guests' pages are throwaway, dropped a day after they were last created or published. */
export const PUBLIC_ASSET_MAX_AGE_MS = 24 * 3600_000;

export async function createDemoHub(o: { mode: DemoMode; env?: Record<string, string | undefined> }): Promise<{ hub: Hub; close(): Promise<void> }> {
  const env = o.env ?? process.env;
  const faas = o.mode === 'faas';
  if (faas) requireFaasEnv(env);
  // One pool for the hub store, the cluster and the assets (lib/db.ts).
  const url = env.DATABASE_URL?.trim() || undefined;
  const pool = url ? sharedPool(url, env) : undefined;
  let store: HubStore;
  if (pool) store = await postgresHubStore({ pool });
  else {
    // Traditional single node only; loaded lazily so the FaaS bundle never pulls in PGlite.
    const { pgliteHubStore } = await import('@uncage/hub/node');
    store = await pgliteHubStore({ dataDir: join(dataDir(env), 'hub') });
  }
  let cluster: ClusterAdapter | undefined;
  if (env.REDIS_URL) cluster = redisCluster({ url: env.REDIS_URL });
  else if (faas && pool) cluster = postgresCluster({ pool });
  const options: HubOptions = {
    publicUrl: publicUrl(env),
    getUser: async (req) => userFromRequest(req),
    store,
    ...(cluster ? { cluster } : {}),
    tools: demoTools,
    skills: demoSkills,
    // The website keeps a replica of every conversation: history stays visible with the machine off.
    sessionStorage: 'site',
    site: { name: 'Uncage Connected Demo' },
    // `TRUSTED_ORIGINS=chrome-extension://<id>,…`: extensions (or other apps) allowed past the cross-site guard.
    ...trustedOrigins(env),
    // `EXPO_PUSH=1`: push notifications to the companion app (approval needed, run finished / failed).
    ...withAttention(attentionHandler(env)),
    // Per-IP rate limits behind a proxy: see clientIpResolver.
    ...withClientIp(clientIpResolver(env)),
  };
  if (faas) {
    // Agent HTTP streams and browser event streams end (and resume) before the route's maxDuration (300 s).
    options.stream = { maxDurationMs: Number(env.UNCAGE_STREAM_MAX_MS) || 250_000 };
    options.maintenance = {
      ...(env.CRON_SECRET ? { secret: env.CRON_SECRET } : {}),
      onRun: async () => {
        const n = await housekeeping(env);
        if (n.assets > 0) console.log(`purged ${n.assets} expired asset(s)`);
        if (n.pushTokens > 0) console.log(`purged ${n.pushTokens} stale push token(s)`);
      },
    };
  }
  const hub = await createHub(options);
  return {
    hub,
    // The hub never closes the store, and closes only a cluster it created itself.
    close: async () => {
      await hub.close();
      await cluster?.close();
      await store.close(); // leaves the shared pool open…
      if (url) await endSharedPool(url); // …which ends here, once
    },
  };
}

/**
 * The demo's periodic cleanup, run hourly by server.ts (traditional) and by the hub's maintenance
 * (FaaS): push tokens the app has not re-registered for 30 days, always; in public mode also the
 * guests' assets last touched more than a day ago.
 */
export async function housekeeping(env: Record<string, string | undefined> = process.env, now: number = Date.now()): Promise<{ pushTokens: number; assets: number }> {
  const pushTokens = await pushTokenStore(env).purgeOlderThan(PUSH_TOKEN_MAX_AGE_MS, now);
  const assets = isPublicDemo(env) ? await assetStore(env).purgeOlderThan(PUBLIC_ASSET_MAX_AGE_MS, now) : 0;
  return { pushTokens, assets };
}

function trustedOrigins(env: Record<string, string | undefined>) {
  const list = (env.TRUSTED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? { trustedOrigins: list } : {};
}

/**
 * `EXPO_PUSH=1`: the hub's `onAttention` sends Expo push notifications to the user's devices, the
 * tokens the app registered at `POST /api/app/push-token` (lib/push-tokens.ts). `EXPO_ACCESS_TOKEN`
 * when the Expo project has enhanced push security on. Tokens Expo reports as unregistered are deleted.
 */
export function attentionHandler(env: Record<string, string | undefined> = process.env, o: { fetch?: typeof fetch } = {}): OnAttention | undefined {
  if (env.EXPO_PUSH !== '1') return undefined;
  const accessToken = env.EXPO_ACCESS_TOKEN?.trim();
  return expoPushNotifier({
    tokensFor: (userId) => pushTokenStore(env).list(userId),
    onInvalidToken: (token) => pushTokenStore(env).remove(token),
    ...(accessToken ? { accessToken } : {}),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
}

function withAttention(onAttention: OnAttention | undefined) {
  return onAttention ? { onAttention } : {};
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
