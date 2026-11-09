---
title: Other Fetch platforms (FaaS mode)
description: Run the hub on any platform that speaks Fetch Request/Response — Netlify Functions, Deno, Bun, other serverless hosts — with hub.fetch and Postgres; what the platform must support, complete files, environment variables, deploy steps, a verification checklist and an FAQ.
---

`hub.fetch(request)` is a plain Fetch handler: `Request` in, `Response` out, Web APIs only. Any platform that runs Fetch handlers and can stream a response can host the hub in FaaS mode. This page gives the general recipe, with Netlify Functions and Bun / Deno as examples. For Vercel and Cloudflare Workers, use their own pages: [Next.js on Vercel](/docs/deploy/vercel/), [Cloudflare Workers](/docs/deploy/cloudflare-workers/).

:::note[Status]
The hub runs on these platforms through the same `hub.fetch` that Vercel and Workers use, but the Uncage team has not verified each platform end to end. The checklist below tells you within minutes whether yours works.
:::

:::caution[Netlify: short limit]
Netlify documents a **60-second execution limit for streaming functions** (and 20 MB per streamed response). The hub works within it, with caveats: set the hub's `stream.maxDurationMs` to about `50000` (the example `hub.ts` below reads it from `UNCAGE_STREAM_MAX_MS`; streams rotate every ~50 s, so more reconnects and more invocations than on Vercel), and keep `toolTimeoutMs` well under 60 s (for example `40_000`), because every site tool call must finish inside one invocation. If your tools need longer, use [Vercel](/docs/deploy/vercel/) or [traditional mode](/docs/deploy/node/).
:::

## Prerequisites

The platform must:

1. **Stream responses** without buffering them: the agent’s stream (`application/x-ndjson`) and browser events (`text/event-stream`) send lines for minutes.
2. **Let a request run for at least about 30 s**, ideally several minutes. Set `stream.maxDurationMs` below the limit. Every site tool call also runs inside one request, so `toolTimeoutMs` must fit too.
3. **Reach Postgres** through `pg` or a pg-compatible `Pool` (Neon’s `@neondatabase/serverless` `Pool` works; HTTP-only query functions do not, because the hub needs transactions).
4. Tell you the **client IP** (a header or a context field), for per-IP rate limits.

**Strongly recommended**: a `waitUntil(promise)` hook. Tool calls run under it, so a dropped connection cannot cut a handler off, and maintenance and cleanup run after the response. Helpful: a cron feature (for the maintenance endpoint).

If the platform forbids sharing sockets between requests (like Workers), create the hub per request with `fetchOnce`, as on the [Workers page](/docs/deploy/cloudflare-workers/#code).

```sh
npm i @uncage/hub pg
npm i -D @types/pg
```

## Code

The hub, created once per instance (process or isolate) and reused by every request it serves:

```ts title="hub.ts"
import { createHub, postgresCluster, postgresHubStore, type Hub, type HubUser } from '@uncage/hub';
import pg from 'pg';

/** Your sign-in: verify the session cookie of a request. Replace the body. */
async function getUser(req: Request): Promise<HubUser | null> {
  const cookie = req.headers.get('cookie') ?? '';
  // Look the session cookie up in your session store here.
  return cookie.includes('session=') ? { id: 'user-123', name: 'Ada' } : null;
}

async function createAppHub(): Promise<Hub> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  pool.on('error', (err) => console.error('postgres pool error:', err.message));
  const ipHeader = process.env.CLIENT_IP_HEADER?.toLowerCase();
  const publicUrl =
    process.env.PUBLIC_URL ?? (process.env.NODE_ENV === 'production' || process.env.VERCEL ? undefined : 'http://localhost:3000');
  if (!publicUrl) throw new Error('PUBLIC_URL is not set: set it to your site’s https:// origin.');
  return createHub({
    publicUrl, // what users open; localhost only for local development
    getUser,
    store: await postgresHubStore({ pool }),
    cluster: postgresCluster({ pool }),
    sessionStorage: 'site',
    // Below the platform's request time limit (default 250 s).
    stream: { maxDurationMs: Number(process.env.UNCAGE_STREAM_MAX_MS) || 250_000 },
    ...(ipHeader ? { rateLimits: { clientIp: (req: Request) => req.headers.get(ipHeader) ?? undefined } } : {}),
    ...(process.env.CRON_SECRET ? { maintenance: { secret: process.env.CRON_SECRET } } : {}),
  });
}

let hub: Promise<Hub> | undefined;

/** The hub of this instance; a failed start (database briefly down) is retried on the next request. */
export function getHub(): Promise<Hub> {
  const p = (hub ??= createAppHub());
  p.catch(() => {
    if (hub === p) hub = undefined;
  });
  return p;
}
```

### Netlify Functions

```ts title="netlify/functions/uncage.ts"
import { getHub } from '../../hub.ts';

/** The fields of Netlify's function context used here. */
interface NetlifyContext {
  ip: string;
  waitUntil(p: Promise<unknown>): void;
}

export default async (req: Request, context: NetlifyContext): Promise<Response> => {
  const hub = await getHub();
  return hub.fetch(req, { clientIp: context.ip, waitUntil: (p) => context.waitUntil(p) });
};

export const config = { path: '/api/uncage/*' };
```

### Bun or Deno (a long-running Fetch server)

Both run a file whose default export has a `fetch` handler: `bun server.ts` (Bun reads `port` from the export) or `deno serve --port 3000 server.ts`. The process keeps running, so the hub lives as long as it does:

```ts title="server.ts"
import { getHub } from './hub.ts';

/** Bun passes its server as the second argument, `deno serve` a connection info object. */
interface BunServer {
  requestIP(req: Request): { address: string } | null;
}
interface DenoServeInfo {
  remoteAddr: { hostname: string };
}

function clientIpOf(req: Request, second: unknown): string | undefined {
  const s = second as Partial<BunServer & DenoServeInfo> | undefined;
  if (typeof s?.requestIP === 'function') return s.requestIP(req)?.address;
  return s?.remoteAddr?.hostname;
}

export default {
  port: 3000,
  async fetch(req: Request, second?: unknown): Promise<Response> {
    if (new URL(req.url).pathname.startsWith('/api/uncage/')) {
      const hub = await getHub();
      // The socket address; behind a proxy set CLIENT_IP_HEADER instead (it wins, see hub.ts).
      const clientIp = clientIpOf(req, second);
      return hub.fetch(req, clientIp ? { clientIp } : {});
    }
    return new Response('Your website');
  },
};
```

You also need the approval page at `/device` (signed-in only, never framed, decided by a POST from your own origin). It calls `hub.lookupDevice`, `hub.approveDevice` and `hub.denyDevice`; the [Workers page](/docs/deploy/cloudflare-workers/#code) has a framework-free version (`devicePage`) you can adapt, and [Auth and device approval](/docs/guides/auth-and-device-approval/) explains the rules.

## Environment variables

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | Your Postgres connection string. Pooled URLs (PgBouncer in transaction mode, Neon `-pooler`) work. |
| `PUBLIC_URL` | yes | The exact `https://` origin users open. |
| `UNCAGE_STREAM_MAX_MS` | if the platform’s limit is under 300 s | When the hub ends long responses: about 10–50 s below the platform’s request time limit. |
| `CLIENT_IP_HEADER` | behind a proxy | The header that carries the client address (for example `x-real-ip`, `cf-connecting-ip`, `x-nf-client-connection-ip`). Only set it if every request really comes through that proxy. |
| `CRON_SECRET` | optional | Enables `GET /api/uncage/maintenance` with `Authorization: Bearer <secret>`, for the platform’s cron. |

The names are this page’s choice; the hub reads no environment variables itself.

## Deploy

1. **Create the database** and set `DATABASE_URL` and `PUBLIC_URL` on the platform.
2. **Find the request time limit** of your plan in the platform’s docs, and set the hub's `stream.maxDurationMs` below it (`UNCAGE_STREAM_MAX_MS` in the example; skip if it is 300 s or more).
3. **Deploy** the way the platform expects (for Netlify, `netlify deploy --prod` with the function above; for Bun or Deno, run `bun server.ts` or `deno serve --port 3000 server.ts` on your host).
4. **Optional:** schedule a daily call to `/api/uncage/maintenance` with the `CRON_SECRET` bearer token. Without it, maintenance still runs opportunistically on requests.

## Verify

- [ ] `curl -s https://your.site/api/uncage/agent/info` answers with the `http` transport (`{"protocol":2,…,"transports":[{"kind":"http",…}]}`).
- [ ] `curl -sN https://your.site/api/uncage/agent/stream` answers `401` quickly (no token); that proves the route reaches the hub.
- [ ] Connect a computer (`uncage setup https://your.site`, approve on `/device`): it shows **online** and stays online for longer than your platform’s time limit. The agent log shows `http stream rotated` lines, not errors.
- [ ] A prompt streams in the chat **while it is being written**, not all at once at the end. If it arrives in one piece, the platform buffers responses: this platform cannot host the hub.
- [ ] A site tool call completes.

## FAQ

### Which platforms are known not to work?

Platforms that buffer the whole response before sending it, or that limit requests to a few seconds. The hub needs streamed responses that stay open for at least about 30 s.

### Can I skip Postgres on a single long-running process?

If your Fetch server is one long-running process (Bun or Deno on a VM), you are effectively in traditional mode. Use Node with `@uncage/hub/node` ([Node page](/docs/deploy/node/)) for WebSockets and the embedded store; on other runtimes, keep Postgres (the embedded store and the WebSocket server are tested on Node only).

### How short can the platform’s time limit be?

The hub works with any `stream.maxDurationMs` above a few seconds, but each rotation is a reconnect and every tool call must finish within the limit. Below about 30 s it is not worth it.

### 504s, cut connections

A request outlived the platform limit: lower `stream.maxDurationMs` (`UNCAGE_STREAM_MAX_MS` in the example), and keep `toolTimeoutMs` (120 s by default) below the limit too. A connection cut by a proxy or the network is harmless: the agent reconnects with its cursor, and nothing is lost or delivered twice.
