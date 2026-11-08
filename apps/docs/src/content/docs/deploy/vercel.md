---
title: Next.js on Vercel (FaaS mode)
description: Run the hub in a Next.js App Router route handler on Vercel with Postgres only — toNextHandlers with waitUntil after, maxDuration, the maintenance cron, Neon and pooled URLs — with complete files, environment variables, deploy steps, a verification checklist and an FAQ.
---

On Vercel the hub runs inside a Next.js **route handler**: no custom server, no WebSocket, no second service. Every function instance is a hub; they share one Postgres database, and users’ computers connect over **HTTP streaming** (a long request the hub ends before Vercel’s time limit, reopened by the agent at once). The same files run under `next start` anywhere. Why FaaS mode, and what it costs: [Choose a deployment mode](/docs/start/choose-deployment-mode/).

## Prerequisites

- A Next.js **15.1 or newer** app with the App Router (the files below use `after` from `next/server`), on Vercel.
- A **Postgres** database reachable from Vercel: Neon, Supabase, Vercel’s Postgres integrations, or your own. Its connection string becomes `DATABASE_URL`. A pooled URL (Neon’s `-pooler` host, PgBouncer) is fine and recommended.
- Your app’s sign-in, readable from a `Request` (the hub) and from `cookies()` (your pages).

```sh
npm i @uncage/hub @uncage/react-ui pg zod
npm i -D @types/pg
```

## Code

Seven files. Paths are relative to your project root.

### Who is signed in

```ts title="lib/auth.ts"
import type { HubUser } from '@uncage/hub';

/**
 * Replace both functions with your real sign-in before you deploy.
 * `userFromRequest` is used by the hub (a Fetch `Request`); `currentUser` by your pages.
 */
export async function userFromRequest(_req: Request): Promise<HubUser | null> {
  return developmentUser();
}

export async function currentUser(): Promise<HubUser | null> {
  return developmentUser();
}

function developmentUser(): HubUser {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('lib/auth.ts still returns the development user: connect it to your sign-in.');
  }
  return { id: 'dev-user', name: 'Developer' };
}
```

### The hub

One hub per function instance, created on the first request (so `next build` never connects to the database) and shared by the route handler and your pages.

```ts title="lib/uncage-hub.ts"
import { createHub, postgresCluster, postgresHubStore, type Hub } from '@uncage/hub';
import pg from 'pg';
import { userFromRequest } from './auth.ts';

async function createAppHub(): Promise<Hub> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set: add your Postgres connection string to the project’s environment variables.');
  // One small pool per function instance, shared by the store and the cluster.
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  pool.on('error', (err) => console.error('postgres pool error:', err.message)); // required for your own pool
  const store = await postgresHubStore({ pool });
  return createHub({
    publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
    getUser: userFromRequest,
    store,
    cluster: postgresCluster({ pool }), // wake-ups between function instances, through Postgres
    sessionStorage: 'site',
    // End long responses (agent streams, browser events) before the route's maxDuration (300 s).
    stream: { maxDurationMs: 250_000 },
    // A site tool runs inside one request: keep its limit well inside maxDuration.
    toolTimeoutMs: 120_000,
    // Enables GET /api/uncage/maintenance for Vercel Cron (it sends Authorization: Bearer $CRON_SECRET).
    ...(process.env.CRON_SECRET ? { maintenance: { secret: process.env.CRON_SECRET } } : {}),
  });
}

const KEY = Symbol.for('my-site.uncage-hub');
type Holder = { [KEY]?: Promise<Hub> };

/** The hub of this function instance. A failed start (database briefly down) is retried on the next call. */
export function getHub(): Promise<Hub> {
  const g = globalThis as Holder;
  const hub = (g[KEY] ??= createAppHub());
  hub.catch(() => {
    if (g[KEY] === hub) delete g[KEY];
  });
  return hub;
}
```

### The route handler

```ts title="app/api/uncage/[...path]/route.ts"
import { toNextHandlers } from '@uncage/hub';
import { after } from 'next/server';
import { getHub } from '../../../../lib/uncage-hub.ts';

// `after`: the hub's background work (maintenance) never delays a response.
export const { GET, POST, PATCH, DELETE } = toNextHandlers(getHub, { waitUntil: after });

/** Seconds a request may run on Vercel. The hub ends its streams earlier (stream.maxDurationMs). */
export const maxDuration = 300;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
```

`toNextHandlers` passes each request to `hub.fetch` with:

- **the client IP** for per-IP rate limits: on Vercel (the `VERCEL` environment variable is set) the address Vercel’s edge puts in `x-real-ip`, which clients cannot spoof there. Anywhere else, pass `clientIp: (req) => …` yourself;
- **`waitUntil`**: Next’s `after`, so maintenance runs after the response.

### The chat page

```tsx title="app/uncage/page.tsx"
'use client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

export default function UncagePage() {
  return (
    <div style={{ height: '100vh' }}>
      <UncageProvider>
        <AgentChat />
      </UncageProvider>
    </div>
  );
}
```

### The approval page

Where `uncage setup` sends the user to approve their computer. Signed-in only, never framed, decided with a Server Action (a POST that Next.js accepts only from your own origin). The same files as in the [quickstart](/docs/start/quickstart-connected/#7-the-approval-page), with `await getHub()`.

```tsx title="app/device/page.tsx"
import type { ApproveDeviceProps } from '@uncage/react-ui';
import { currentUser } from '../../lib/auth.ts';
import { getHub } from '../../lib/uncage-hub.ts';
import { ApprovePage } from './approve-page.tsx';

export const dynamic = 'force-dynamic';

type DeviceError = NonNullable<ApproveDeviceProps['error']>;

export default async function DevicePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code = '' } = await searchParams;
  const user = await currentUser();
  if (!user) return <p>Sign in first, then open this link again.</p>; // or redirect to your login page
  let lookup: ApproveDeviceProps['lookup'] = null;
  let error: DeviceError | undefined;
  try {
    lookup = code ? await (await getHub()).lookupDevice(code, user) : null;
  } catch (e) {
    // Unknown codes count as failed guesses; after 10 in 10 minutes lookupDevice throws `rate_limited`.
    const err = e as { code?: string; message?: string };
    error = { code: err.code === 'rate_limited' ? 'rate_limited' : 'internal_error', message: err.message ?? 'Could not check this code.' };
  }
  return <ApprovePage code={code} lookup={lookup} initialError={error} />;
}
```

```ts title="app/device/actions.ts"
'use server';
import { currentUser } from '../../lib/auth.ts';
import { getHub } from '../../lib/uncage-hub.ts';

export type DecideResult = { result: 'ok' | 'not_found' | 'expired' } | { error: { code: string; message: string } };

/** A Server Action: a POST that Next.js only accepts from this site's own Origin. */
export async function decide(code: string, approve: boolean): Promise<DecideResult> {
  const user = await currentUser();
  if (!user) return { error: { code: 'unauthorized', message: 'Sign in again.' } };
  try {
    const hub = await getHub();
    return { result: await (approve ? hub.approveDevice(code, user) : hub.denyDevice(code, user)) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { error: { code: err.code ?? 'internal_error', message: err.message ?? 'Failed' } };
  }
}
```

```tsx title="app/device/approve-page.tsx"
'use client';
import { ApproveDevice, type ApproveDeviceProps, type ApproveDeviceState } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';
import { useState } from 'react';
import { decide } from './actions.ts';

export function ApprovePage({
  code,
  lookup,
  initialError,
}: Pick<ApproveDeviceProps, 'code' | 'lookup'> & { initialError?: ApproveDeviceProps['error'] }) {
  const [state, setState] = useState<ApproveDeviceState>('idle');
  const [error, setError] = useState<ApproveDeviceProps['error']>(initialError);
  const act = async (approve: boolean) => {
    setState(approve ? 'approving' : 'denying');
    setError(undefined);
    const r = await decide(code, approve);
    if ('error' in r) {
      setState('idle'); // the buttons stay enabled for a retry
      setError(r.error as ApproveDeviceProps['error']);
    } else {
      setState(r.result === 'ok' ? (approve ? 'approved' : 'denied') : r.result);
    }
  };
  return <ApproveDevice code={code} lookup={lookup} state={state} error={error} onApprove={() => void act(true)} onDeny={() => void act(false)} />;
}
```

### Headers and the cron

```ts title="next.config.ts"
import type { NextConfig } from 'next';

const config: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
```

```json title="vercel.json"
{ "crons": [{ "path": "/api/uncage/maintenance", "schedule": "0 4 * * *" }] }
```

Maintenance (retention cleanup, failing tool calls whose instance died) also runs by itself on ordinary requests, at most once a minute across all instances, through `after`. The cron is a safety net for quiet periods. Vercel Hobby allows one run a day; Pro can run it hourly or more often.

## Environment variables

Set them in the Vercel project (Settings → Environment Variables) for Production and Preview, and in `.env.local` for `next dev`.

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | Your Postgres connection string. Pooled URLs (Neon `-pooler`, PgBouncer in transaction mode) work. The hub creates its tables on the first request. |
| `PUBLIC_URL` | yes | The exact origin users open, for example `https://app.example.com` (your production domain, not a preview URL). It goes into the install and setup commands. |
| `CRON_SECRET` | recommended | A random string (`openssl rand -hex 32`). Vercel Cron sends it as `Authorization: Bearer …`; the hub’s `/maintenance` endpoint exists only when it is set. |
| Your auth secrets | yes | Whatever `lib/auth.ts` needs. |

## Deploy

1. **Create the database.** For example Neon through the Vercel Marketplace (it sets `DATABASE_URL` for you), or any Postgres 14+. Pick a region close to your Vercel functions’ region: every poll is a round trip.
2. **Set the environment variables** above.
3. **Deploy**: push to the connected Git repository, or `npx vercel --prod`.
4. **Open your site** at `/uncage`, connect a computer, and work through the checklist below.

To try it on your own machine first: `next build && next start` with a local Postgres (`docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=uncage postgres:16-alpine` and `DATABASE_URL=postgres://postgres:uncage@localhost:5432/postgres`).

## Verify

Replace `https://your.site` with your `PUBLIC_URL`.

- [ ] `curl -s https://your.site/api/uncage/agent/info` lists only the `http` transport:

  ```json
  {"protocol":2,"minAgentVersion":"0.3.0","transports":[{"kind":"http","url":"https://your.site/api/uncage/agent"}]}
  ```

- [ ] `curl -s https://your.site/api/uncage/install.sh | head -2` prints `#!/usr/bin/env bash` and `# Uncage installer…`.
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://your.site/api/uncage/maintenance` prints `401` (with `CRON_SECRET` set; `404` without). With the secret, `curl -s -H "Authorization: Bearer $CRON_SECRET" https://your.site/api/uncage/maintenance` answers `{"ran":true,…}` (or `"ran":false` if another instance ran it within the last minute).
- [ ] Connect a computer from `/uncage` (the page shows the commands to run; approve the code on `/device`). It shows **online** within a few seconds.
- [ ] Send a prompt. The answer streams. The agent’s log (`uncage agent` in a terminal, or `~/.uncage/logs/agent.log`) shows `http stream rotated` about every 250 s, and the chat keeps working across rotations.
- [ ] Vercel’s function logs show no `504` on `/api/uncage/agent/stream`. Streams end with status 200 before 300 s.

## FAQ

### I see 504 errors (`FUNCTION_INVOCATION_TIMEOUT`)

A request ran longer than `maxDuration`. Keep **`stream.maxDurationMs` below `maxDuration`**, with a margin of about 50 s: `maxDuration = 300` → `250_000` (the default). If you lower `maxDuration` (to 60, say), lower `stream.maxDurationMs` too (`10_000` less, at least). Pro plans may raise `maxDuration` to 800; you can raise `stream.maxDurationMs` with it, but there is little gain: a rotation costs one reconnect.

### `maxDuration` vs `stream.maxDurationMs` vs `toolTimeoutMs`

- `maxDuration` (seconds, in `route.ts`) is Vercel’s hard limit for any request to the route.
- `stream.maxDurationMs` is when the hub itself ends its long responses (agent streams and browser event streams) so clients reconnect cleanly. It must be below `maxDuration`.
- `toolTimeoutMs` is how long one site tool handler may run. Each tool call runs inside one request from the agent, so it must also fit inside `maxDuration`, including any file pull. If Vercel stops the function mid-handler, the call fails with “Site tool "<name>" timed out on the website. Please try again.” and is never re-run (at most once).

### Attachments over about 4 MB fail

Vercel refuses request bodies over about 4.5 MB with its own `413` before the hub sees them. The hub itself accepts 10 MiB. Users get a generic error unless you check `Content-Length` on `POST /api/uncage/sessions/:id/attachments` first and answer the hub’s `attachment_too_large` shape; the reference demo’s [route handler](https://github.com/ptmafia/uncage/blob/main/examples/connected-demo/app/api/uncage/%5B%5B...path%5D%5D/route.ts) does this with a 4 MB limit. Agent traffic is never affected: the agent sends at most 1 MB per request and pulls files in chunks.

### Uploads fail on slow connections with `400`

A request body must arrive within `bodyTimeoutMs` (30 s by default). Raise it (`bodyTimeoutMs: 120_000`) if your users upload attachments over slow links; keep it below `maxDuration`.

### Neon: which driver?

Use `pg` (as above) or Neon’s `@neondatabase/serverless` **`Pool`** (`postgresHubStore({ pool })` accepts either). Do not use the HTTP-only `neon()` function: the hub needs transactions on one connection. The pooled `-pooler` URL is fine: the hub’s migrations take transaction-scoped locks, which work behind transaction-mode poolers.

### Does Neon’s free tier ever go to sleep?

Not while a computer is online or a function instance is warm: open agent streams and `postgresCluster` poll every 0.3 to 2 s. Budget for an always-on compute while you have users connected, or see [what FaaS mode costs](/docs/start/choose-deployment-mode/#what-faas-mode-costs).

### Do I need Redis?

No. Add it (`cluster: redisCluster({ url: process.env.REDIS_URL! })`, install `ioredis`) for lower latency and less database polling with many instances. Upstash Redis works if it speaks the Redis protocol over TCP (`rediss://`).

### Rate limits behind another proxy

`toNextHandlers` reads `x-real-ip`, which Vercel’s edge sets. If another proxy or CDN sits in front of Vercel, that header holds the proxy’s address: pass `toNextHandlers(getHub, { waitUntil: after, clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined })` with your proxy’s client-IP header.

### Users see “Agent update needed”

Their computer runs an agent older than 0.3, which cannot connect over HTTP streaming. The page shows the fix: `npm i -g @uncage/cli@latest`, then the setup command again. See [Troubleshooting](/docs/reference/troubleshooting/#agent-update-needed--426-upgrade_required).

### Can a site tool handler run for minutes?

Not on Vercel: it runs inside one request, limited by `maxDuration`. Start the long work as a background job and return an id the model can check with a second tool, or host the hub in [traditional mode](/docs/deploy/node/).
