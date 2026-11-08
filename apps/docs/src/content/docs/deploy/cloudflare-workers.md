---
title: Cloudflare Workers (FaaS mode)
description: Run the hub in a native Cloudflare Worker with Postgres through Hyperdrive — one hub per request with fetchOnce, ctx.waitUntil, cf-connecting-ip, nodejs_compat for pg, a Cron Trigger for maintenance — with complete files, environment, deploy steps, a verification checklist and an FAQ.
---

A Worker cannot keep objects that do I/O (database sockets) between requests, so on Workers the hub is created **per request**: `fetchOnce` builds a hub on a fresh Postgres pool, serves the request, and closes both once the response has finished (streams included). Everything that must outlive a request lives in Postgres, reached through **Hyperdrive**. Users’ computers connect over HTTP streaming. Why FaaS mode: [Choose a deployment mode](/docs/start/choose-deployment-mode/).

:::note[Status]
This setup runs on `wrangler dev` (workerd) with a real Uncage agent, in the repository’s [`examples/connected-cloudflare`](https://github.com/ptmafia/uncage/tree/main/examples/connected-cloudflare). A deployed Worker has not been verified end to end by the Uncage team yet; tell us how it goes.
:::

## Prerequisites

- A Cloudflare account and `wrangler` 4.158 or newer (`npm i -D wrangler`). Older versions do not accept the `compatibility_date` below.
- A **Postgres** database reachable from Cloudflare (Neon, Supabase, your own), and a **Hyperdrive** configuration for it. Locally, any Postgres (for example in Docker).
- Your site’s sign-in, readable from a `Request` inside the Worker (a session cookie you can verify).

```sh
npm i @uncage/hub pg
npm i -D wrangler @types/pg
```

## Code

Four files.

```toml title="wrangler.toml"
name = "my-site"
main = "src/worker.ts"
compatibility_date = "2026-10-01"
# For the pg driver only (TCP sockets); @uncage/hub itself uses Web APIs only.
compatibility_flags = ["nodejs_compat"]

[vars]
PUBLIC_URL = "http://localhost:8787" # set your deployed origin before going live

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<your Hyperdrive id>" # wrangler hyperdrive create … prints it
localConnectionString = "postgres://postgres:uncage@127.0.0.1:5432/postgres" # used by wrangler dev

# Maintenance (retention cleanup) once a day; requests also run it opportunistically.
[triggers]
crons = ["0 4 * * *"]
```

```ts title="src/auth.ts"
import type { HubUser } from '@uncage/hub';
import type { Env } from './hub.ts';

/**
 * Your sign-in: the user a request belongs to, or null. Replace the body with a real check of
 * your session cookie, for example a signed token verified with crypto.subtle, or a lookup in
 * your session table. Until then, only local development (wrangler dev) has a user.
 */
export async function userFromRequest(req: Request, env: Env): Promise<HubUser | null> {
  const local = ['localhost', '127.0.0.1'].includes(new URL(req.url).hostname);
  if (local && env.PUBLIC_URL.startsWith('http://localhost')) return { id: 'dev-user', name: 'Developer' };
  return null;
}
```

```ts title="src/hub.ts"
import { createHub, postgresCluster, postgresHubStore, type Hub } from '@uncage/hub';
import pg from 'pg';
import { userFromRequest } from './auth.ts';

export interface Env {
  /** Hyperdrive binding (wrangler.toml); wrangler dev uses its localConnectionString. */
  HYPERDRIVE: { connectionString: string };
  /** The Worker's public origin, e.g. https://my-site.example.workers.dev. */
  PUBLIC_URL: string;
}

/** A pool for one request: Workers forbid reusing sockets across requests. At most 5 connections. */
export function newPool(env: Env): pg.Pool {
  const pool = new pg.Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
  // workerd closes a finished request's sockets; pg reports that on idle clients. Log anything else.
  pool.on('error', (err) => {
    if (!/socket has been closed/i.test(err.message)) console.error('postgres pool error:', err.message);
  });
  return pool;
}

/** The hub for one request on `pool`, and the cleanup of what was built for it (the pool is the caller's). */
export async function makeHub(env: Env, pool: pg.Pool): Promise<{ hub: Hub; close(): Promise<void> }> {
  const store = await postgresHubStore({ pool });
  const cluster = postgresCluster({ pool });
  const close = async () => {
    await cluster.close();
    await store.close(); // leaves the pool open
  };
  try {
    const hub = await createHub({
      publicUrl: env.PUBLIC_URL,
      getUser: (req) => userFromRequest(req, env),
      store,
      cluster,
      sessionStorage: 'site',
    });
    return { hub, close };
  } catch (e) {
    await close();
    throw e;
  }
}
```

```ts title="src/worker.ts"
import { fetchOnce } from '@uncage/hub';
import { userFromRequest } from './auth.ts';
import { makeHub, newPool, type Env } from './hub.ts';

/** The part of Workers' ExecutionContext used here (`wrangler types` generates the full one). */
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/uncage/')) {
      return fetchOnce(
        async (defer) => {
          const pool = newPool(env);
          defer(() => pool.end()); // runs after the response, also if building the hub fails
          return makeHub(env, pool);
        },
        req,
        // Bound: an unbound ctx.waitUntil throws "Illegal invocation".
        { waitUntil: ctx.waitUntil.bind(ctx), clientIp: req.headers.get('cf-connecting-ip') ?? undefined },
      );
    }
    if (url.pathname === '/device') return devicePage(req, url, env, ctx);
    return new Response('Your website');
  },

  /** Cron Trigger: run the hub's maintenance (it skips if another instance ran it within the minute). */
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const pool = newPool(env);
    const work = (async () => {
      const { hub, close } = await makeHub(env, pool);
      try {
        console.log('uncage maintenance', JSON.stringify(await hub.maintain()));
      } finally {
        await hub.close();
        await close();
      }
    })().finally(() => pool.end());
    ctx.waitUntil(work);
  },
};

/** /device: where a signed-in user approves `uncage setup`'s code. Never framed; POST from this origin only. */
async function devicePage(req: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const user = await userFromRequest(req, env);
  if (!user) return page('<p>Sign in first, then open this link again.</p>', 401);
  if (req.method === 'POST' && req.headers.get('origin') !== url.origin) return page('<p>Cross-site request refused.</p>', 403);
  const pool = newPool(env);
  try {
    const { hub, close } = await makeHub(env, pool);
    try {
      if (req.method === 'POST') {
        const form = await req.formData();
        const code = String(form.get('code') ?? '');
        const approve = form.get('decision') === 'approve';
        const result = approve ? await hub.approveDevice(code, user) : await hub.denyDevice(code, user);
        if (result === 'ok') return page(approve ? '<p>Approved. You can close this tab.</p>' : '<p>Denied.</p>');
        return page(`<p>This code is ${result === 'expired' ? 'expired' : 'unknown'}. Run <code>uncage setup</code> again.</p>`, 410);
      }
      const code = url.searchParams.get('code') ?? '';
      const info = code ? await hub.lookupDevice(code, user) : null;
      if (!info) return page('<p>Unknown or expired code. Run <code>uncage setup</code> again.</p>', 404);
      const repair = info.repairsMachine ? `<p>This re-pairs <b>${esc(info.repairsMachine.name)}</b>.</p>` : '';
      return page(
        `<form method="post"><p>Connect <b>${esc(info.name ?? 'a computer')}</b> to your account? Check that it shows the code <b>${esc(code)}</b>.</p>${repair}` +
          `<input type="hidden" name="code" value="${esc(code)}"><button name="decision" value="approve">Approve</button> <button name="decision" value="deny">Deny</button></form>`,
      );
    } finally {
      await hub.close();
      await close();
    }
  } catch (e) {
    // Unknown codes count as failed guesses: after 10 in 10 minutes the hub refuses with rate_limited.
    if ((e as { code?: string }).code === 'rate_limited') return page('<p>Too many attempts. Try again in a few minutes.</p>', 429);
    console.error('device page failed:', e);
    return page('<p>Something went wrong. Try again shortly.</p>', 500);
  } finally {
    ctx.waitUntil(pool.end());
  }
}

function page(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Connect your computer</title>${body}`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' },
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
```

What matters here:

- **One hub per request.** `fetchOnce(create, req, …)` calls `create(defer)` for every request. Register cleanups with `defer` as you open things; return the hub, or `{ hub, close }`. After the response body has finished or was cancelled (never earlier, so streams keep working), it runs `hub.close()`, then `close`, then the deferred cleanups.
- **Migrations are checked once per isolate**: a fresh pool costs one cheap `SELECT max(id)`, no lock and no DDL.
- **`waitUntil: ctx.waitUntil.bind(ctx)`** keeps the isolate alive for the hub’s background work and the cleanup.
- **`clientIp` from `cf-connecting-ip`**, which Cloudflare sets, for per-IP rate limits.
- Your sign-in goes in `getUser` (`src/auth.ts`). The repository example has a demo sign-in that lets anyone become any user; it refuses to work on a public host, and it is **not** something to copy into a real site.

## Environment variables

| Name | Kind | What it is |
| --- | --- | --- |
| `HYPERDRIVE` | Hyperdrive binding | Your Postgres, through Hyperdrive (`[[hyperdrive]]` in `wrangler.toml`). `wrangler dev` uses `localConnectionString` instead, or the `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` environment variable. |
| `PUBLIC_URL` | var | The exact origin users open, `https://…` (plain `http://` only for localhost). It goes into the install and setup commands. |
| Your auth secrets | secret | Whatever `src/auth.ts` needs: `wrangler secret put <NAME>`. For `wrangler dev`, put them in `.dev.vars`. |

No `CRON_SECRET` is needed: the Cron Trigger calls `scheduled` directly. (If you prefer an HTTP cron, set `maintenance: { secret }` in `createHub` and call `GET /api/uncage/maintenance` with `Authorization: Bearer <secret>`.)

## Deploy

1. **Run it locally first.** Start a Postgres matching `localConnectionString`, then:

   ```sh
   docker run -d --name pg -p 5432:5432 -e POSTGRES_PASSWORD=uncage postgres:16-alpine
   npx wrangler dev        # http://localhost:8787
   ```

2. **Create the Hyperdrive configuration** and put its id in `wrangler.toml`:

   ```sh
   npx wrangler login
   npx wrangler hyperdrive create my-site-db --connection-string="postgres://user:password@host:5432/db"
   ```

3. **Deploy once** to learn your Worker’s URL: `npx wrangler deploy`.
4. **Set `PUBLIC_URL`** in `wrangler.toml` to that URL (or your custom domain), add your auth secrets with `wrangler secret put`, and deploy again.
5. **Wire your real sign-in** into `src/auth.ts` before you send anyone the link.

## Verify

Replace `https://my-site.example.workers.dev` with your `PUBLIC_URL` (or use `http://localhost:8787` under `wrangler dev`).

- [ ] `curl -s https://my-site.example.workers.dev/api/uncage/agent/info` lists only `http`:

  ```json
  {"protocol":2,"minAgentVersion":"0.3.0","transports":[{"kind":"http","url":"https://my-site.example.workers.dev/api/uncage/agent"}]}
  ```

- [ ] `curl -s https://my-site.example.workers.dev/api/uncage/install.sh | head -2` prints the installer’s first lines.
- [ ] `npx wrangler tail` while you connect a computer (`uncage setup https://my-site.example.workers.dev`, approve on `/device`): no errors, and the computer shows online.
- [ ] Run a prompt that calls one of your site tools; the tool step completes.
- [ ] `npx wrangler deploy --dry-run --outdir dist` succeeds: the bundle has no Node-only hub code (the root `@uncage/hub` entry is Web-standard; only `pg` uses `nodejs_compat`).

## FAQ

### Why a new hub for every request? Isn’t that slow?

Workers forbid sharing sockets between requests, so a shared pool is not an option. Building a hub is cheap: no migrations after the first request of an isolate (one `SELECT max(id)`), and Hyperdrive keeps the real database connections warm. The repository example measured about 350 ms for a command’s round trip through the stream on workerd.

### Do site tools run exactly once on Workers?

Yes, when you pass `waitUntil: ctx.waitUntil.bind(ctx)` as above. Workers may cancel a request’s remaining work when its client disconnects, so the hub runs each tool call’s handler under `waitUntil`: if the agent’s POST drops mid-call, the handler still finishes, its result is stored, and the agent’s retry gets it — **exactly once**, as on Node and Vercel (`toNextHandlers` uses the platform’s `waitUntil`, or pass Next’s `after`). A connected agent still gets the result in the same response. Without `waitUntil` a dropped POST can stop the handler: it stores no result, and once its lease runs out (`toolTimeoutMs` + 10 s) the call fails with “Site tool "<name>" timed out on the website. Please try again.” — never run twice (**at most once**). The same happens if the isolate itself is stopped mid-handler (an instance kill, or a handler outliving the platform’s `waitUntil` limit), so keep handlers short and make them idempotent where you can (a retry by the model then does no harm).

### 504s or streams cut early?

HTTP Workers have no wall-clock limit while the client stays connected, and waiting on I/O does not count as CPU time, so the default `stream.maxDurationMs` (250 s) is fine. If your plan or a proxy in front cuts long requests earlier, lower `stream.maxDurationMs` below that limit.

### Neon or Supabase without Hyperdrive?

Use Hyperdrive: it pools and caches connections close to the Worker. Without it, Neon’s `@neondatabase/serverless` `Pool` (WebSockets) also works with `postgresHubStore({ pool })`; its HTTP-only `neon()` function does not (the hub needs transactions on one connection).

### Why `nodejs_compat`?

Only for `pg`, which opens TCP sockets through `cloudflare:sockets`. `@uncage/hub`’s root entry uses Web APIs only; `@uncage/hub/node` (WebSocket server, PGlite) is never bundled.

### Can computers use WebSockets here?

Not with this setup: nothing in a Worker accepts the agents’ WebSockets (that would need Durable Objects). The hub offers only `http`, and agents use it. An agent older than 0.3 that tries a WebSocket gets `426 upgrade_required` and the site shows “Agent update needed”.

### Rate limits behind another proxy?

`cf-connecting-ip` is the client address as Cloudflare saw it. With another proxy in front of Cloudflare, read that proxy’s client-IP header instead.
