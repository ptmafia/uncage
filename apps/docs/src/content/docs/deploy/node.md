---
title: Node (traditional mode)
description: Deploy the hub in a long-running Node.js process with zero external dependencies (PGlite + WebSocket), behind a reverse proxy, with a complete server, environment variables, deploy steps, a verification checklist and an FAQ.
---

Traditional mode is the hub inside a Node.js process that keeps running: a VM, a container, Railway, Fly.io, Render or your own server. It needs **no external service**: the hub keeps its data in an embedded Postgres (PGlite) folder, and users’ computers hold a WebSocket to it. Not sure this is your mode? See [Choose a deployment mode](/docs/start/choose-deployment-mode/).

## Prerequisites

- Node.js **22.18 or newer**: it runs the `.ts` server below directly, without a build step (older versions need `--experimental-strip-types`, or compile with `tsc` first).
- A host that keeps the process running and gives it a **persistent disk** for the hub’s data folder (`.uncage-hub`). Without one, every restart forgets the paired computers and users must run `uncage setup` again.
- In front of it, a proxy or load balancer that forwards **WebSocket upgrades** on `/api/uncage/agent` (most hosts do by default) and serves `https://`.
- Your app’s sign-in, readable from a Fetch `Request` (a session cookie).

```sh
npm i @uncage/hub express
```

## Code

Two files. `auth.ts` stands for your sign-in; replace its body.

```ts title="auth.ts"
import type { HubUser } from '@uncage/hub';

/** Your sign-in: the user a request belongs to, or null. */
export async function getSessionUser(req: Request): Promise<HubUser | null> {
  const cookie = req.headers.get('cookie') ?? '';
  // Look the session cookie up in your session store here.
  return cookie.includes('session=') ? { id: 'user-123', name: 'Ada' } : null;
}
```

```ts title="server.ts"
import { createServer } from 'node:http';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import express from 'express';
import { getSessionUser } from './auth.ts';

const port = Number(process.env.PORT ?? 3000);

// Embedded Postgres in a folder: one process per folder, kept across restarts.
const store = await pgliteHubStore({ dataDir: process.env.UNCAGE_DATA_DIR ?? './.uncage-hub' });
const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  getUser: getSessionUser,
  store,
  sessionStorage: 'site', // keep a copy of every conversation on your site
});

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY)); // proxies in front: req.ip is the client
app.use(toNodeHandler(hub)); // first, before express.json() or compression()
app.use(express.json());
app.get('/', (_req, res) => {
  res.send('Your website');
});

const server = createServer(app);
attachWebSocket(hub, server); // computers connect to ws(s)://<host>/api/uncage/agent
server.listen(port, () => console.log(`ready on http://localhost:${port}`));

// On deploy or restart: stop taking requests, let running site tools finish, then close the store.
process.once('SIGTERM', () => {
  server.close();
  void hub
    .close()
    .then(() => store.close())
    .finally(() => process.exit(0));
});
```

What each piece does:

- `toNodeHandler(hub)` serves everything under `/api/uncage` (the browser API, the device login, `install.sh` and `install.ps1`, and the HTTP streaming transport) and passes other paths to `next()`. It hands the hub `req.ip` for per-IP rate limits.
- `attachWebSocket(hub, server)` accepts the computers’ WebSockets on the same HTTP server and runs the hub’s maintenance (retention cleanup) every minute. With it, the hub offers both transports: agents use WebSocket, and fall back to HTTP streaming by themselves if WebSockets keep failing (a proxy that blocks upgrades, for example).
- `hub.close()` never closes your `store`: close it after the hub.

Using Fastify, Hono or a Next.js custom server instead of Express? [Mount the hub](/docs/guides/mount-the-hub/) has a complete server for each. Next.js on its own: the [Connected Mode quickstart](/docs/start/quickstart-connected/) builds this setup into a Next.js app.

## Environment variables

| Variable | Required | What it is |
| --- | --- | --- |
| `PUBLIC_URL` | yes, in production | The exact origin users open, for example `https://app.example.com`. It goes into the install and setup commands, so it must be `https://` (plain `http://` only for `localhost`). |
| `PORT` | no | The port to listen on (default `3000`). |
| `UNCAGE_DATA_DIR` | no | The hub’s PGlite folder (default `./.uncage-hub`). Put it on the persistent disk. Add it to `.gitignore`. |
| `TRUST_PROXY` | behind a proxy | The number of proxies in front of the app, for `app.set('trust proxy', …)`. Without it, every user shares one rate-limit bucket (see the FAQ). |

These names are this page’s choice; the hub itself reads no environment variables.

## Deploy

1. **Build and start** with `node server.ts` (Node 22.18+). In a container, for example:

   ```dockerfile title="Dockerfile"
   # Node 22.18 or newer runs server.ts directly (type stripping); node:22 is the latest 22.x.
   FROM node:22-slim
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --omit=dev
   COPY . .
   ENV UNCAGE_DATA_DIR=/data/uncage-hub
   VOLUME /data
   EXPOSE 3000
   CMD ["node", "server.ts"]
   ```

2. **Give it a persistent volume** at the data folder (`/data` above). Railway, Fly.io and Render call it a volume or disk.
3. **Set `PUBLIC_URL`** to your `https://` origin, and `TRUST_PROXY=1` if a proxy or load balancer sits in front (it almost always does on a platform).
4. **Check the proxy** in front:
   - forwards WebSocket upgrades on `/api/uncage/agent`, with an idle timeout above 30 s (the hub pings every 10 s);
   - does not buffer `text/event-stream` responses (browser events) or `application/x-ndjson` ones (agent streams);
   - keeps the original `Host` header.

   nginx, for example:

   ```nginx title="nginx.conf (excerpt)"
   location / {
     proxy_pass http://127.0.0.1:3000;
     proxy_http_version 1.1;
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_buffering off;
     proxy_read_timeout 300s;
   }
   ```

5. **Run one process per data folder.** PGlite locks its folder. For more than one process, see [Multi-node](/docs/guides/multi-node/).

## Verify

Replace `https://your.site` with your `PUBLIC_URL`.

- [ ] `curl -s https://your.site/api/uncage/install.sh | head -2` prints `#!/usr/bin/env bash` and `# Uncage installer…`.
- [ ] `curl -s https://your.site/api/uncage/agent/info` lists **both** transports, `ws` first:

  ```json
  {"protocol":2,"minAgentVersion":"0.3.0","transports":[{"kind":"ws","url":"wss://your.site/api/uncage/agent"},{"kind":"http","url":"https://your.site/api/uncage/agent"}]}
  ```

  Only `http`? `attachWebSocket` did not run in this process.
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://your.site/api/uncage/health` prints `401` (signed out). Signed in, the browser gets `{"ok":true,…}`.
- [ ] On a computer, run the command your page shows (or `uncage setup https://your.site`), approve the code on `/device`, and the page shows the computer **online**.
- [ ] Restart the server: the computer comes back online within about 30 s without a new `uncage setup` (the data folder survived).

## FAQ

### My site is on Vercel or Netlify. Can I still use traditional mode?

Yes, as a separate service. Run this server on a host with WebSockets, and route `https://your.site/api/uncage/*` **including WebSocket upgrades** to it at your edge (a load balancer, Cloudflare, nginx in front of both), so it is the **same origin** as your site: the browser API relies on your site’s cookies and same-origin checks. Vercel rewrites do not proxy WebSockets (agents then fall back to HTTP streaming, which works but loses the instant delivery). In `getUser`, verify your site’s session cookie without your framework’s helpers (for example the signed JWT your auth library issues). Your `/device` approval page needs `hub.approveDevice`, which lives in this process: serve `/device` from it too, or expose a small authenticated, CSRF-protected endpoint your page calls. Often simpler: use [FaaS mode on Vercel](/docs/deploy/vercel/) directly.

### `uncage setup` fails with `429 rate_limited` for many users at once

Behind a proxy the hub sees the proxy’s address unless told otherwise, so all users share one bucket of 20 device codes per minute. Set `TRUST_PROXY` (above), or pass `rateLimits: { clientIp: (req) => req.headers.get('x-real-ip') ?? undefined }` with your proxy’s client-IP header. Details: [behind a proxy](/docs/guides/mount-the-hub/#behind-a-reverse-proxy-or-load-balancer).

### The proxy blocks WebSockets. Does it still work?

Yes. After three failed WebSocket attempts the agent switches to HTTP streaming (served by the same `toNodeHandler`) and tries WebSocket again every 30 minutes. Fix the proxy anyway: WebSocket delivers commands instantly and costs less.

### Can I use Postgres instead of PGlite?

Yes: `store: await postgresHubStore({ connectionString: process.env.DATABASE_URL! })` (install `pg`). Do it when you want managed backups or more than one node. Pooled connection strings (PgBouncer, Neon `-pooler`) work: migrations use transaction-scoped locks.

### Do I need Redis?

Not for one process. For several nodes, add `redisCluster` (or `postgresCluster`) as shown in [Multi-node](/docs/guides/multi-node/).

### A deploy restarted the server. What happened to running work?

Computers reconnect by themselves (backoff from 1 s up to 30 s). Runs keep going on the users’ computers and their events backfill on reconnect. A site tool handler still running when the process stops fails with “Site tool "<name>" timed out on the website. Please try again.”: `hub.close()` gives running handlers `toolDrainMs` (5 s) to finish first.

### Old agents (0.2) cannot connect

The hub tells them to upgrade (`upgrade_required`) and 0.2 agents upgrade themselves with `npm i -g @uncage/cli@latest`. See [Troubleshooting](/docs/reference/troubleshooting/#agent-update-needed--426-upgrade_required).
