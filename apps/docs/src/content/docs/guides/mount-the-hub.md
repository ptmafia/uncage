---
title: Mount the hub
description: Complete servers that mount @uncage/hub in a Next.js custom server, Express, Fastify or Hono, plus every createHub option, proxies, and how to host the hub when the website runs on Vercel.
---

The hub needs two things from your server:

1. **HTTP requests** under its base path (default `/api/uncage`): the browser API, the device endpoints and `install.sh`. Use `hub.handler(request)` (Fetch API) or `toNodeHandler(hub)` (Node `req, res, next`).
2. **WebSocket upgrades** at `<basePath>/agent`, where connected computers dial in. `hub.attach(httpServer)` registers them on your Node HTTP server.

So the hub runs in a long-lived Node process (Node.js 22 or newer). Each example below is a complete server file. All of them import the same `getSessionUser` from `./auth`, which stands for your app’s sign-in (see [Auth and device approval](/uncage/guides/auth-and-device-approval/)):

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
import { createHub, toNodeHandler } from '@uncage/hub';
import express from 'express';
import { getSessionUser } from './auth.ts';

const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
});

const app = express();
// app.set('trust proxy', 1); // behind one reverse proxy: makes req.ip the client address (rate limits)
app.use(toNodeHandler(hub)); // first, before express.json() or compression()
app.use(express.json());
app.get('/', (_req, res) => {
  res.send('Your website');
});

const server = createServer(app);
hub.attach(server);
server.listen(3000, () => console.log('http://localhost:3000'));
```

`toNodeHandler(hub)` only handles paths under `hub.basePath` and passes everything else to `next()`. Mounting it with a prefix (`app.use('/api/uncage', toNodeHandler(hub))`) works too; it reads `req.originalUrl`.

## Fastify

Fastify parses request bodies itself, so give the hub a scope with no body parsers and hand it the raw request:

```ts title="fastify-server.ts"
import { createHub, toNodeHandler } from '@uncage/hub';
import Fastify from 'fastify';
import { getSessionUser } from './auth.ts';

const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
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
hub.attach(app.server);
await app.listen({ port: 3000 });
```

## Hono (Node)

With `@hono/node-server`, pass the Fetch `Request` straight to `hub.handler` and give it the client address for rate limits:

```ts title="hono-server.ts"
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createHub } from '@uncage/hub';
import { Hono, type Context } from 'hono';
import { getSessionUser } from './auth.ts';

const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
});

const app = new Hono();
const toHub = (c: Context) => hub.handler(c.req.raw, { clientIp: getConnInfo(c).remote.address });
app.all(hub.basePath, toHub);
app.all(`${hub.basePath}/*`, toHub);
app.get('/', (c) => c.text('Your website'));

const server = serve({ fetch: app.fetch, port: 3000 });
hub.attach(server as Server);
```

## Next.js (custom server)

Next.js route handlers cannot accept WebSocket upgrades, so run Next.js inside your own Node server and put the hub next to it. This is what the [Connected Mode quickstart](/uncage/start/quickstart-connected/) and the `connected-demo` example do:

```ts title="server.ts"
import { createServer } from 'node:http';
import { createHub, toNodeHandler } from '@uncage/hub';
import next from 'next';
import { getSessionUser } from './auth.ts';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);

const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  getUser: getSessionUser,
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
hub.attach(server);
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
import { createHub, toNodeHandler } from '@uncage/hub';
import { getSessionUser } from './auth.ts';

const hub = await createHub({ publicUrl: 'http://localhost:3000', getUser: getSessionUser });
const hubHandler = toNodeHandler(hub);

const server = createServer((req, res) => hubHandler(req, res)); // no next(): other paths get 404
hub.attach(server);
server.listen(3000);
```

## Check it

```sh
curl -s http://localhost:3000/api/uncage/install.sh | head -3   # public: prints the installer
curl -s http://localhost:3000/api/uncage/health                 # needs a signed-in user: 401 without
```

`/health` answers `{"ok":true,"protocol":"1.0","version":"…"}` for a signed-in user and `401 unauthorized` otherwise.

## `createHub` options

Only `publicUrl` and `getUser` are required.

| Option | Default | What it does |
| --- | --- | --- |
| `publicUrl` | (required) | Your website’s public origin, for example `https://app.example.com`. Used for the install and setup commands, the `/device` link and the CSRF origin check. |
| `getUser(req)` | (required) | Your auth: `{ id, name? }` for a signed-in browser request, else `null`. |
| `basePath` | `/api/uncage` | Where the hub is mounted. If you change it, pass the same path to `UncageProvider` as `baseUrl`. |
| `tools` | `[]` | Site tools from `defineTool`. [Guide](/uncage/guides/define-tools/) |
| `skills` | `[]` | `SkillSpec[]`. [Guide](/uncage/guides/write-skills/) |
| `selectManifest(ctx)` | all tools and skills | Picks tools and skills per run. [Guide](/uncage/guides/select-manifest/) |
| `sessionStorage` | `'machine'` | `'site'` keeps a replica of every conversation. [Guide](/uncage/guides/site-storage/) |
| `attachmentRetentionDays` | `30` | Days the hub keeps its copy of attachments sent through the website (hourly sweep; `Infinity` keeps them). A revoked computer's attachments are deleted at once. [Details](/uncage/guides/site-storage/#attachments) |
| `store` | `pgliteHubStore({ dataDir: './.uncage-hub' })` | `HubStore`. Use `postgresHubStore` for several nodes. |
| `cluster` | `memoryCluster()` | `ClusterAdapter`. Use `redisCluster` for several nodes. [Guide](/uncage/guides/multi-node/) |
| `site` | id and name from `publicUrl`’s host | `{ id?, name? }` shown to computers at pairing. Keep `id` stable. |
| `verificationPath` | `/device` | Your approval page. [Guide](/uncage/guides/auth-and-device-approval/) |
| `minAgentVersion` | this hub’s version | Older agents are told to upgrade (`upgrade_required`); they run `npm i -g @uncage/cli@latest` and reconnect. |
| `cliVersionRange` | `^<major.minor>` of the hub | Which `@uncage/cli` version `install.sh` installs (`^0.2`, `~0.2.1`, `0.2.0` or `latest`). |
| `heartbeat` | `{ pingIntervalMs: 10000, missedPings: 2 }` | A silent computer shows offline after about 30 s. |
| `sseHeartbeatMs` | `15000` | Keep-alive comments on browser event streams. |
| `commandTimeoutMs` | `30000` | How long a browser request waits for the computer. |
| `toolTimeoutMs` | `120000` | A tool handler still running after this fails with `tool_failed`. |
| `maxConcurrentToolCalls` | `8` | Tool calls one computer may have running at once. |
| `rateLimits` | see below | Abuse limits for device login. |

`rateLimits`: `deviceCodesPerMinute` (20 per client IP), `userCodeFailures` (10 failed code guesses per user) per `userCodeWindowMs` (10 minutes), `clientIp(req)` and `trustForwardedFor` (see [behind a proxy](#behind-a-reverse-proxy-or-load-balancer)). Exceeding a limit answers `429 rate_limited`. Limits are counted per node.

The `Hub` you get back has `basePath`, `handler(req, info?)`, `attach(server, { path? })`, `approveDevice`, `denyDevice`, `lookupDevice`, `revokeMachine` and `close()`. `close()` closes the store and cluster only if the hub created them; close your own after it.

## Behind a reverse proxy or load balancer

:::caution[Set the client IP before you go live]
`POST <basePath>/device/code` (every `uncage setup`) is limited to **20 per minute per client IP**. Behind a reverse proxy, load balancer or CDN the hub sees the proxy's address, not the user's, unless you tell it otherwise. Then **all your users share one bucket**: from the 21st setup in a minute, site-wide, `uncage setup` fails with `429 rate_limited`.

Fix it with one of:

- Express: `app.set('trust proxy', 1)` (the number of proxies in front of the app). `toNodeHandler` then passes `req.ip`.
- Any server: `rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined }` (use your platform's client-IP header).
- `rateLimits: { trustForwardedFor: true }`, only if your proxy appends the client address to `X-Forwarded-For` (the hub uses the rightmost entry).
:::

- **Forward WebSocket upgrades** on `<basePath>/agent` (nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`), and allow long-lived connections (the hub pings every 10 s).
- **Keep the original `Host`** (nginx: `proxy_set_header Host $host;`). The hub compares a request’s `Origin` with `publicUrl` and its `Host` to refuse cross-site POSTs.
- **Do not buffer SSE** on `<basePath>/sessions/*/events` (nginx: `proxy_buffering off;`).
- **Client IP for rate limits.** Express: `app.set('trust proxy', 1)`, and `toNodeHandler` uses `req.ip`. Fetch-style servers: pass `rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined }` (or your platform’s header), or `trustForwardedFor: true` if your proxy appends the client address to `X-Forwarded-For`. Without any of these, every client is counted as the proxy's address (or as one `shared` bucket), so the limit applies to all users together.
- **TLS.** Terminate it wherever you like, but `publicUrl` must be the `https://` URL users open. The agent refuses plain `http://` for anything but `localhost` and `127.0.0.1`.

## Serverless hosting (Vercel, Netlify)

Serverless functions cannot hold WebSockets, so they cannot host the hub. Keep your site where it is and run the hub as a small Node service (any of the servers above) on a host that supports WebSockets (Fly.io, Railway, Render, a container, a VM). Then make it the **same origin** as your site, because the browser API relies on your site’s cookies and same-origin checks:

- Route `https://your.site/api/uncage/*` **including WebSocket upgrades** to the hub service at your edge (a load balancer, Cloudflare, nginx in front of both). Vercel rewrites do not proxy WebSockets, so do this in front of Vercel, not inside it.
- Set `publicUrl` to `https://your.site`.
- In `getUser`, verify your site’s session cookie without your framework’s helpers: for example verify the signed JWT your auth library issues, or look the session id up in the shared session database.
- Your approval page stays on the site; it needs `hub.approveDevice`, which only exists in the hub process. Either serve `/device` from the hub service too (route it there), or expose a small authenticated, CSRF-protected endpoint on the hub service that your page calls.
