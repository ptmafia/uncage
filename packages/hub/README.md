# @uncage/hub

The Connected Mode hub, mounted in your website: device login for the Uncage CLI, the installers
(`install.sh`, `install.ps1`), the transports users' machines dial into (WebSocket and HTTP
streaming), and the browser API (same shapes as the local daemon's `/v1`). Sessions run on the
user's own machine; the hub routes commands and events, executes your site tools, and relays
attachments.

The root entry is a Web-standard Fetch handler (`hub.fetch(request)`) that runs on any platform. It
has two deployment modes ([which one?](https://uncage.vercel.app/docs/start/choose-deployment-mode/)):

**Traditional mode**: a long-running Node process, zero external dependencies. The Node-only parts
live in `@uncage/hub/node`.

```ts
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';

const store = await pgliteHubStore({ dataDir: './.uncage-hub' }); // embedded Postgres in a folder
const hub = await createHub({
  publicUrl: 'https://app.example.com',
  getUser: async (req) => sessionUser(req), // your auth: { id } or null
  store,
});
app.use(toNodeHandler(hub)); // Express / Connect / node:http, before body parsers
attachWebSocket(hub, httpServer); // machine WebSockets at /api/uncage/agent
// shutdown: await hub.close(); await store.close();
```

**FaaS mode**: serverless functions and Fetch platforms (Next.js on Vercel, Cloudflare Workers, …).
State lives in Postgres; machines connect over resumable HTTP streaming.

```ts
// app/api/uncage/[...path]/route.ts (Next.js on Vercel)
import { createHub, postgresCluster, postgresHubStore, toNextHandlers } from '@uncage/hub';
import { after } from 'next/server';
import pg from 'pg';

const getHub = async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  pool.on('error', (err) => console.error(err));
  return createHub({ publicUrl, getUser, store: await postgresHubStore({ pool }), cluster: postgresCluster({ pool }) });
};
export const { GET, POST, PATCH, DELETE } = toNextHandlers(getHub, { waitUntil: after });
export const maxDuration = 300; // the hub ends its streams before this (stream.maxDurationMs, 250 s)
```

On Cloudflare Workers, `fetchOnce(create, req, { waitUntil: ctx.waitUntil.bind(ctx), clientIp })`
creates a hub per request on a per-request pool. Complete files and checklists per platform:
[Node](https://uncage.vercel.app/docs/deploy/node/), [Vercel](https://uncage.vercel.app/docs/deploy/vercel/),
[Cloudflare Workers](https://uncage.vercel.app/docs/deploy/cloudflare-workers/),
[other Fetch platforms](https://uncage.vercel.app/docs/deploy/other-fetch-platforms/). Upgrading from
0.2: [migration guide](https://uncage.vercel.app/docs/reference/migrate-from-0-2/).

`store` is required, and the hub never closes it. The hub requires agents 0.3 or newer
(`minAgentVersion`); older agents are told to upgrade.

Every `Session` the browser API returns (create, list, snapshot, settings, and `session.*` events)
carries `machineId`, the computer it runs on, so UIs can show that computer's status.

## Site tools

`defineTool` declares a website capability that the agent sees as an MCP tool. The machine gets
only the name, description and JSON Schema (from the zod `input`). The handler runs **on the hub**,
on the instance that receives the call (the node holding the machine's WebSocket, or whichever
instance gets the agent's HTTP POST):

- `ctx.user` is the session owner. The hub checks that the session belongs to this machine and user
  before it calls the handler.
- A run can only call the tools its manifest offered (what `selectManifest` picked when the run
  started, recorded per run in the store). A registered tool left out of the manifest fails with
  `tool_failed` (`details.reason: 'not_in_manifest'`). Calls for runs not started through the hub are
  refused.
- Only runtimes that report `capabilities.siteTools` (Claude Code) get tools. For others (Codex) the
  hub drops the tools, keeps the skills, and the run shows a `system.warning`
  (`site_tools_unsupported`). `selectManifest` receives the session's `runtime`.
- Arguments are validated, and parsed, with `input` first. If they do not match, the call fails
  with `invalid_request` and the handler is not called.
- Return a `ToolCallResult`, a string (becomes a text block) or any JSON value (becomes a json
  block). A throw becomes `tool_failed` with the thrown message.
- **Thrown messages are shown to the user and the model** (they travel to the machine as the tool
  error). Throw user-safe messages: no stack traces, SQL, internal hostnames or secrets. Log the
  details on your side instead.
- One machine connection may have at most `maxConcurrentToolCalls` (default 8) calls executing at
  once. Further calls fail with `tool_failed` (`details.reason: 'too_many_concurrent'`).
- A handler still running after `toolTimeoutMs` (default 120 s) fails with `tool_failed`. If the run
  ends first, the call is cancelled. In both cases, and when `hub.close()` runs out of `toolDrainMs`,
  `ctx.signal` aborts.
- **Exactly once on connection drop**: the call and its result are stored under the call's id, and a
  re-sent call gets the stored result (kept 24 h) instead of a second run. **At most once on instance
  kill**: if the instance running the handler dies, the call fails with "Site tool "<name>" timed out
  on the website. Please try again." (`details.reason: 'interrupted'`) and is never re-run. Keep
  handlers within your platform's request time limit and idempotent where you can.
- Every call is recorded in the store (`store.listToolCalls(sessionId)`). The browser sees it in the
  session's events as the runtime's own `tool.*` events.

```ts
import { defineTool, type ToolContext, type SiteTool } from '@uncage/hub';
import { z } from 'zod';

const publishSite = defineTool({
  name: 'publish_site',
  description: 'Publish a folder of the session workspace to the user’s site',
  input: z.object({ dir: z.string() }),
  handler: async ({ dir }, ctx: ToolContext) => {
    const pull = ctx.files.pull(dir, { maxBytes: 20 * 1024 * 1024 });
    for await (const file of pull) await cdn.put(ctx.user.id, file.path, file.data);
    return { published: dir, skipped: pull.skipped };
  },
});
const hub = await createHub({ ..., tools: [publishSite] });
```

`ctx.files` is the file channel, which reads from the session workspace on the machine:

- `pull(path, { maxBytes })` returns every file under a file or directory: at most 50 MiB in total,
  10 MiB per file. It is all-or-nothing. If the pull fails part-way, nothing is yielded and it
  throws. The machine never follows symlinks and refuses paths outside the workspace. A directory
  pull skips hard-linked files and lists them in `pull.skipped`.
- `read(path)` returns one file's bytes. The path is normalized first (`./a//b` → `a/b`); a
  directory fails with `invalid_request` and a missing path with `not_found`.

## Attachments

`POST <base>/sessions/:id/attachments` accepts up to 10 MiB (`HUB_ATTACHMENT_MAX_BYTES`). The
runtime may set a lower limit, for example 5 MB images for Claude Code; the machine enforces it.

- Small files go to the machine in one frame (`addAttachment`).
- Larger ones are sent in 256 KiB chunks (`attachment_begin` / `attachment_chunk` /
  `attachment_end`), across nodes if needed.
- On Vercel, request bodies over about 4.5 MB are refused by the platform before the hub sees them.

The hub keeps its own copy of each attachment for the chat history, in both `sessionStorage` modes
(also `'machine'`). It is deleted after `attachmentRetentionDays` (default 30, removed by the hub's
maintenance) and when the machine is revoked.

## Storage and clustering

| | single node (default) | several nodes |
|---|---|---|
| `store` (required) | `pgliteHubStore({ dataDir })` from `@uncage/hub/node`: embedded Postgres, one process per data dir | `postgresHubStore({ connectionString } \| { pool })` (needs `pg`) |
| `cluster` | `memoryCluster()`: in-process | `redisCluster({ url } \| { client })` (needs `ioredis`), or `postgresCluster({ pool } \| { connectionString })` on the same Postgres |

Both stores use the same tables and SQL and meet the same `HubStore` contract. Migrations run on
start; with Postgres they run in one transaction under a transaction-scoped advisory lock, so nodes
can start together, also behind PgBouncer / Neon `-pooler`. FaaS mode is multi-node by nature:
every function instance is a node.

`postgresCluster` polls a messages table (300 ms while busy, backing off to 2 s), needs no
`LISTEN/NOTIFY`, and delivers at most once with a 2 s gap bound (a lost command times out on the
website; browser streams backfill from the store). A long-lived node polls at least every 2 s, so a
scale-to-zero database never sleeps while it runs; use Redis where that matters.

Connection errors: node-postgres emits `'error'` on a pool when an idle connection dies (database
restart, failover), and with no listener that crashes the process. A pool or Redis client the hub
creates (`{ connectionString }`, `{ url }`) gets a listener that logs (`onError`, default
`console.error`). **If you pass your own `{ pool }` or `{ client }`, attach your own `'error'`
listener.** `redisCluster`'s `keyPrefix` (default `uncage:`) prefixes its pub/sub channels as well
as its presence keys, so several deployments can share one Redis.

With several nodes behind a load balancer, a machine's WebSocket lives on one node (A) while browser
requests land anywhere (B):

- B looks up the machine's presence in the cluster, publishes the command to A's channel, and A
  forwards it to the machine and publishes the result back. A machine on HTTP streaming gets the
  command through its durable outbox in the store instead, and its stream is woken through the cluster.
- Session events fan out over the cluster.
- An approval decision is applied once: the machine is the single arbiter, so the second of two
  racing decisions gets `409`.

```ts
import { createHub, postgresHubStore, redisCluster } from '@uncage/hub';

const hub = await createHub({
  publicUrl: 'https://app.example.com',
  getUser,
  store: await postgresHubStore({ connectionString: process.env.DATABASE_URL! }),
  cluster: redisCluster({ url: process.env.REDIS_URL! }),
});
```

Rate limits (device codes, failed user-code guesses, failed machine tokens) are counted in the store,
so every node and function instance shares them.

**`POST /device/code` is limited per client IP (20 per minute).** Behind a proxy or load balancer the
hub only knows the client IP if you tell it: Express `app.set('trust proxy', <hops>)` (then
`toNodeHandler` passes `req.ip`), or `rateLimits.clientIp(req)` / `rateLimits.trustForwardedFor`.
On Vercel, `toNextHandlers` reads the address Vercel's edge sets; on Workers pass
`cf-connecting-ip` to `fetchOnce`. Otherwise every user shares one `shared` bucket, and 20 setups
per minute across your whole site start failing with `429 rate_limited`.

### Tests

`pnpm test` runs everything in-process: PGlite, plus `ioredis-mock` for two hub nodes in one
process. `UNCAGE_DOCKER_TESTS=1 pnpm --filter @uncage/hub test` also starts `redis:7-alpine` and
`postgres:16-alpine` with `docker run` on random loopback ports. It runs the store and cluster
contracts and the two-node scenario against them, then removes the containers.
