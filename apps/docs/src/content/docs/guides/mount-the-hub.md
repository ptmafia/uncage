---
title: Mount the hub
description: Complete Node servers that mount @uncage/hub in Express, Fastify, Hono, a Next.js custom server or plain node:http (traditional mode), the hub as a Fetch handler for serverless platforms, every createHub option, and proxies.
---

The hub is a Fetch handler: `hub.fetch(request)` answers everything under its base path (default `/api/uncage`): the browser API, the device login, `install.sh` / `install.ps1`, and the computers’ HTTP streaming transport. How you mount it depends on where your website runs ([Choose a deployment mode](/docs/start/choose-deployment-mode/)):

- **A long-running Node process (traditional mode)**: this page. From `@uncage/hub/node`, `toNodeHandler(hub)` mounts `hub.fetch` as Node middleware and `attachWebSocket(hub, server)` accepts the computers’ WebSockets on your HTTP server. The store is `pgliteHubStore`, an embedded Postgres in a folder: nothing else to run.
- **Serverless or a Fetch platform (FaaS mode)**: [Next.js on Vercel](/docs/deploy/vercel/) (`toNextHandlers`), [Cloudflare Workers](/docs/deploy/cloudflare-workers/) (`fetchOnce`), [other Fetch platforms](/docs/deploy/other-fetch-platforms/) (`hub.fetch`). These need Postgres.

Each example below is a complete Node.js 22+ server file. All of them import the same `getSessionUser` from `./auth`, which stands for your app’s sign-in (see [Auth and device approval](/docs/guides/auth-and-device-approval/)):

```ts title="auth.ts"
import type { HubUser } from '@uncage/hub';

/** Your sign-in: the user a request belongs to, or null. */
export async function getSessionUser(req: Request): Promise<HubUser | null> {
  const cookie = req.headers.get('cookie') ?? '';
  // Look the session cookie up in your session store here.
  return cookie.includes('session=') ? { id: 'user-123', name: 'Ada' } : null;
}
```

## Express

```ts title="express-server.ts"
import { createServer } from 'node:http';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import express from 'express';
import { getSessionUser } from './auth.ts';

const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
  store,
});

const app = express();
// app.set('trust proxy', 1); // behind one reverse proxy: makes req.ip the client address (rate limits)
app.use(toNodeHandler(hub)); // first, before express.json() or compression()
app.use(express.json());
app.get('/', (_req, res) => {
  res.send('Your website');
});

const server = createServer(app);
attachWebSocket(hub, server); // computers connect to ws(s)://<host>/api/uncage/agent
server.listen(3000, () => console.log('http://localhost:3000'));
```

`toNodeHandler(hub)` only handles paths under `hub.basePath` and passes everything else to `next()`. Mounting it with a prefix (`app.use('/api/uncage', toNodeHandler(hub))`) works too; it reads `req.originalUrl`.

## Fastify

Fastify parses request bodies itself, so give the hub a scope with no body parsers and hand it the raw request:

```ts title="fastify-server.ts"
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import Fastify from 'fastify';
import { getSessionUser } from './auth.ts';

const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
  store,
});
const hubHandler = toNodeHandler(hub);

const app = Fastify();
await app.register(async (scope) => {
  // Leave the request body unread: the hub streams it itself.
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser('*', (_req, _payload, done) => done(null));
  for (const url of [hub.basePath, `${hub.basePath}/*`]) {
    scope.all(url, (req, reply) => {
      reply.hijack();
      hubHandler(req.raw, reply.raw);
    });
  }
});
app.get('/', async () => 'Your website');

await app.ready();
attachWebSocket(hub, app.server);
await app.listen({ port: 3000 });
```

## Hono (Node)

With `@hono/node-server`, pass the Fetch `Request` straight to `hub.fetch` and give it the client address for rate limits:

```ts title="hono-server.ts"
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore } from '@uncage/hub/node';
import { Hono, type Context } from 'hono';
import { getSessionUser } from './auth.ts';

const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
  store,
});

const app = new Hono();
const toHub = (c: Context) => hub.fetch(c.req.raw, { clientIp: getConnInfo(c).remote.address });
app.all(hub.basePath, toHub);
app.all(`${hub.basePath}/*`, toHub);
app.get('/', (c) => c.text('Your website'));

const server = serve({ fetch: app.fetch, port: 3000 });
attachWebSocket(hub, server as Server);
```

## Next.js (custom server)

To keep traditional mode (WebSocket, embedded store, no database to run) in a Next.js app, run Next.js inside your own Node server and put the hub next to it: route handlers cannot accept WebSocket upgrades. This is what the [Connected Mode quickstart](/docs/start/quickstart-connected/) and the `connected-demo` example do. (Without a custom server, mount the hub in a route handler instead: [Next.js on Vercel](/docs/deploy/vercel/), which works under `next start` too.)

```ts title="server.ts"
import { createServer } from 'node:http';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import next from 'next';
import { getSessionUser } from './auth.ts';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);

const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  getUser: getSessionUser,
  store: await pgliteHubStore({ dataDir: './.uncage-hub' }),
});
// Pages and Server Actions (for example /device) get the hub from here.
(globalThis as Record<symbol, unknown>)[Symbol.for('my-site.uncage-hub')] = hub;
const hubHandler = toNodeHandler(hub);

const server = createServer();
const app = next({ dev, hostname: 'localhost', port, httpServer: server });
const handle = app.getRequestHandler();
await app.prepare();

server.on('request', (req, res) => {
  hubHandler(req, res, () => void handle(req, res));
});
attachWebSocket(hub, server);
if (dev) {
  const upgrade = app.getUpgradeHandler(); // hot reload
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== `${hub.basePath}/agent`) void upgrade(req, socket, head);
  });
}
server.listen(port);
```

Start it with `node server.ts` (Node 22.18+ runs TypeScript directly) instead of `next dev`. The quickstart shows the matching `package.json` and `tsconfig.json` settings and a typed `getHub()` helper for pages.

## Plain `node:http`

```ts title="node-server.ts"
import { createServer } from 'node:http';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import { getSessionUser } from './auth.ts';

const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
const hub = await createHub({ publicUrl: 'http://localhost:3000', getUser: getSessionUser, store });
const hubHandler = toNodeHandler(hub);

const server = createServer((req, res) => hubHandler(req, res)); // no next(): other paths get 404
attachWebSocket(hub, server);
server.listen(3000);
```

## Check it

```sh
curl -s http://localhost:3000/api/uncage/install.sh | head -3   # public: prints the installer
curl -s http://localhost:3000/api/uncage/agent/info             # public: protocol and offered transports
curl -s http://localhost:3000/api/uncage/health                 # needs a signed-in user: 401 without
```

`/agent/info` lists `ws` then `http` when `attachWebSocket` runs in this process (only `http` otherwise). `/health` answers `{"ok":true,"protocol":"1.0","version":"…"}` for a signed-in user and `401 unauthorized` otherwise.

Add `.uncage-hub/` to `.gitignore`, and keep that folder on a persistent disk in production: it holds the paired computers. One process per folder (PGlite locks it); for several processes see [Multi-node](/docs/guides/multi-node/).

## `createHub` options

`publicUrl`, `getUser` and `store` are required.

| Option | Default | What it does |
| --- | --- | --- |
| `publicUrl` | (required) | Your website’s public origin, for example `https://app.example.com`. Used for the install and setup commands, the `/device` link, the transport URLs and the CSRF origin check. Must be `https://` (plain `http://` only for `localhost`, `127.0.0.1`, `[::1]`). |
| `getUser(req)` | (required) | Your auth: `{ id, name? }` for a signed-in browser request or app (`Authorization: Bearer …`, [guide](/docs/guides/authenticate-apps/)), else `null`. |
| `trustedOrigins` | `[]` | Extra exact origins allowed past the cross-site guard, such as `chrome-extension://<id>` ([guide](/docs/guides/browser-extension/)). No wildcards or paths; https, extension schemes, or `http` on localhost only. Only origins you control. Native apps need none: they send no `Origin`. |
| `onAttention(event, ctx)` | none | Called when an approval is requested or a run completes or fails, to send a push notification. At most once per event, never for events older than 10 minutes. `expoPushNotifier` is a ready handler. [Guide](/docs/guides/push-notifications/) |
| `store` | (required) | `HubStore`. `pgliteHubStore({ dataDir })` from `@uncage/hub/node` for one Node process; `postgresHubStore({ connectionString } \| { pool })` for several nodes and FaaS. The hub never closes it. |
| `cluster` | `memoryCluster()` | `ClusterAdapter`. `redisCluster` or `postgresCluster` for several nodes and FaaS. [Guide](/docs/guides/multi-node/) |
| `basePath` | `/api/uncage` | Where the hub is mounted. If you change it, pass the same path to `UncageProvider` as `baseUrl`. |
| `tools` | `[]` | Site tools from `defineTool`. [Guide](/docs/guides/define-tools/) |
| `skills` | `[]` | `SkillSpec[]`. [Guide](/docs/guides/write-skills/) |
| `selectManifest(ctx)` | all tools and skills | Picks tools and skills per run. [Guide](/docs/guides/select-manifest/) |
| `sessionStorage` | `'machine'` | `'site'` keeps a replica of every conversation. [Guide](/docs/guides/site-storage/) |
| `attachmentRetentionDays` | `30` | Days the hub keeps its copy of attachments sent through the website (`Infinity` keeps them). A revoked computer's attachments are deleted at once. [Details](/docs/guides/site-storage/#attachments) |
| `site` | id and name from `publicUrl`’s host | `{ id?, name? }` shown to computers at pairing. Keep `id` stable. |
| `verificationPath` | `/device` | Your approval page. [Guide](/docs/guides/auth-and-device-approval/) |
| `minAgentVersion` | `0.3.0` | Older agents are told to upgrade (`upgrade_required`). Over WebSocket they upgrade themselves; in FaaS mode the website shows “Agent update needed”. |
| `cliVersionRange` | `^<major.minor>` of the hub | Which `@uncage/cli` version `install.sh` / `install.ps1` install (`^0.3`, `~0.3.1`, `0.3.0` or `latest`). |
| `installScript` | none | Static extra text for the installers: a step after the CLI install and/or your own “no agent found” help. |
| `transports` | `['ws', 'http']` with `attachWebSocket`, else `['http']` | Transports offered to agents. List `ws` when another process serves the WebSockets at `<basePath>/agent`; leave `http` out to offer WebSockets only. |
| `stream` | `{ maxDurationMs: 250000 }` | The hub ends agent streams and browser event streams after this long, and clients reconnect at once without a gap. Keep it below your platform’s request time limit. |
| `polling` | `{ activeMs: 300, idleMs: 2000, activeWindowMs: 30000 }` | How often an agent’s HTTP stream polls its outbox: fast while active, backing off to `idleMs` when quiet. |
| `heartbeat` | `{ pingIntervalMs: 10000, missedPings: 2 }` | A silent computer shows offline after about 30 s. |
| `sseHeartbeatMs` | `15000` | Keep-alive comments on browser event streams. |
| `commandTimeoutMs` | `30000` | How long a browser request waits for the computer. |
| `bodyTimeoutMs` | `30000` | A request body is refused with `400` if no bytes arrive for this long, or if it takes more than 4 times this long in total. Slow but steady uploads get through. |
| `logger` | the console | Where the hub reports warnings and errors (`{ warn(obj, msg), error(obj, msg) }`; pino and most loggers fit). The default writes `[uncage] …` lines with `console.warn` and `console.error`. Pass `{ warn() {}, error() {} }` to silence it. On Vercel and Workers, `toNextHandlers` and `fetchOnce` log a one-time warning when the hub has no `cluster` (presence is then per instance); see [serverless hosting](#serverless-hosting-vercel-netlify-workers). |
| `toolTimeoutMs` | `120000` | A tool handler still running after this fails with `tool_failed`. In FaaS mode keep it inside the platform’s time limit. |
| `toolDrainMs` | `5000` | `hub.close()` lets running tool handlers finish for this long, then aborts them. |
| `maxConcurrentToolCalls` | `8` | Tool calls one computer may have running at once on one hub instance. |
| `rateLimits` | see below | Abuse limits for device login and machine tokens. |
| `maintenance` | `{ intervalMs: 60000 }` | Retention cleanup, see below. |

`rateLimits`: `deviceCodesPerMinute` (20 per client IP), `userCodeFailures` (10 failed code guesses per user) per `userCodeWindowMs` (10 minutes), `agentAuthFailuresPerMinute` (60 requests with a missing or wrong machine token per client IP; valid tokens are never limited), `clientIp(req)` and `trustForwardedFor` (see [behind a proxy](#behind-a-reverse-proxy-or-load-balancer)). Exceeding a limit answers `429 rate_limited`. The counts live in the store, so every node and function instance shares them.

`maintenance` deletes what is no longer needed (unanswered run manifests after 1 h, others after 7 days; attachment copies after `attachmentRetentionDays`; deduplication rows and stored tool results after 24 h; expired outbox items and device codes) and fails site tool calls whose instance died mid-handler. It runs at most once per `intervalMs` across all instances: on a timer when `attachWebSocket` runs, otherwise triggered by requests (after the response when the platform gives a `waitUntil`). `secret` enables `GET|POST <basePath>/maintenance` with `Authorization: Bearer <secret>`, for a platform cron (Vercel Cron sends `CRON_SECRET` this way). `onRun()` runs your own cleanup after each run.

The `Hub` you get back has `basePath`, `fetch(req, info?)`, `approveDevice`, `denyDevice`, `lookupDevice`, `revokeMachine`, `maintain()` and `close()`. `info` is `{ clientIp?, waitUntil? }`. `close()` never closes the store, and closes the cluster only if the hub created it; close yours after it.

## Behind a reverse proxy or load balancer

:::caution[Set the client IP before you go live]
`POST <basePath>/device/code` (every `uncage setup`) is limited to **20 per minute per client IP**. Behind a reverse proxy, load balancer or CDN the hub sees the proxy's address, not the user's, unless you tell it otherwise. Then **all your users share one bucket**: from the 21st setup in a minute, site-wide, `uncage setup` fails with `429 rate_limited`.

Fix it with one of:

- Express: `app.set('trust proxy', 1)` (the number of proxies in front of the app). `toNodeHandler` then passes `req.ip`.
- Next.js on Vercel: nothing to do, `toNextHandlers` reads the address Vercel’s edge sets. Cloudflare Workers: pass `clientIp: req.headers.get('cf-connecting-ip') ?? undefined` to `fetchOnce`.
- Any server: `rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined }` (use your platform's client-IP header).
- `rateLimits: { trustForwardedFor: true }`, only if your proxy appends the client address to `X-Forwarded-For` (the hub uses the rightmost entry).
:::

- **Forward WebSocket upgrades** on `<basePath>/agent` (nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`), and allow long-lived connections (the hub pings every 10 s). If upgrades fail, agents fall back to HTTP streaming by themselves, but WebSocket is faster.
- **Keep the original `Host`** (nginx: `proxy_set_header Host $host;`). The hub compares a request’s `Origin` with `publicUrl` and its `Host` to refuse cross-site POSTs.
- **Do not buffer streams**: SSE on `<basePath>/sessions/*/events` and NDJSON on `<basePath>/agent/stream` (nginx: `proxy_buffering off;`). Allow requests of at least `stream.maxDurationMs` (250 s).
- **Client IP for rate limits.** Express: `app.set('trust proxy', 1)`, and `toNodeHandler` uses `req.ip`. Fetch-style servers: pass `hub.fetch(req, { clientIp })`, or `rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined }` (or your platform’s header), or `trustForwardedFor: true` if your proxy appends the client address to `X-Forwarded-For`. Without any of these, every client is counted as the proxy's address (or as one `shared` bucket), so the limit applies to all users together.
- **TLS.** Terminate it wherever you like, but `publicUrl` must be the `https://` URL users open. The agent refuses plain `http://` for anything but `localhost` and `127.0.0.1`.

## Serverless hosting (Vercel, Netlify, Workers)

Serverless functions cannot hold WebSockets, but they do not need to: in FaaS mode the hub runs in your functions, keeps its state in Postgres, and computers connect over HTTP streaming. Follow the page for your platform:

- [Next.js on Vercel](/docs/deploy/vercel/): `toNextHandlers(getHub, { waitUntil: after })` in `app/api/uncage/[...path]/route.ts`.
- [Cloudflare Workers](/docs/deploy/cloudflare-workers/): `fetchOnce` creates a hub per request on a Hyperdrive pool.
- [Other Fetch platforms](/docs/deploy/other-fetch-platforms/): `hub.fetch(req, { clientIp, waitUntil })`.

Prefer to keep traditional mode next to a serverless site? Run one of the servers above as its own service on the same origin: [Node → FAQ](/docs/deploy/node/#my-site-is-on-vercel-or-netlify-can-i-still-use-traditional-mode).
