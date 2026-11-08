---
title: Migrate from 0.2
description: Every breaking change in Uncage 0.3 with before/after code — @uncage/hub is Web-standard, Node parts move to @uncage/hub/node, store is required, hub.fetch and attachWebSocket replace hub.handler and hub.attach, agents must be 0.3 or newer — plus the new options and HubStore additions.
---

Uncage 0.3 makes the hub platform-agnostic: the same hub runs in a Node process (traditional mode) or on serverless and Fetch platforms (FaaS mode), see [Choose a deployment mode](/docs/start/choose-deployment-mode/). There is no compatibility layer for 0.2, so a 0.2 website needs the small changes below. Update every `@uncage/*` package you depend on to 0.3 together (they share one version; also `@uncage/server`, `@uncage/core`, `@uncage/agent` and the runtimes if you use them; users update `@uncage/cli` themselves).

```sh
npm i @uncage/hub@^0.3 @uncage/react-ui@^0.3 @uncage/react@^0.3 @uncage/client@^0.3 @uncage/protocol@^0.3 # every @uncage/* package you use, together
```

## A traditional-mode server, before and after

Most 0.2 sites need exactly this change:

```ts nocheck
// 0.2
import { createHub, toNodeHandler } from '@uncage/hub';

const hub = await createHub({ publicUrl, getUser });
app.use(toNodeHandler(hub));
const server = createServer(app);
hub.attach(server);
```

```ts title="server.ts"
// 0.3
import { createServer } from 'node:http';
import { createHub, type HubUser } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import express from 'express';

declare function getUser(req: Request): Promise<HubUser | null>;

const store = await pgliteHubStore({ dataDir: './.uncage-hub' }); // the folder 0.2 used by default
const hub = await createHub({ publicUrl: 'https://app.example.com', getUser, store });
const app = express();
app.use(toNodeHandler(hub));
const server = createServer(app);
attachWebSocket(hub, server);
server.listen(3000);
```

Keep `dataDir: './.uncage-hub'` (or whatever folder you used) and your paired computers, sessions and replicas carry over: the store runs its new migrations on start.

## Breaking changes

### `@uncage/hub` root is Web-standard; Node parts moved to `@uncage/hub/node`

The root entry uses Web APIs only, so it bundles for Workers, Vercel and other Fetch platforms. The Node-only pieces moved:

| 0.2 (`@uncage/hub`) | 0.3 |
| --- | --- |
| `toNodeHandler(hub)` | `toNodeHandler(hub)` from **`@uncage/hub/node`** |
| `hub.attach(server, { path? })` | `attachWebSocket(hub, server, { path? })` from **`@uncage/hub/node`**. Returns a `detach()` function; `hub.close()` detaches too. One server per hub at a time. |
| `pgliteHubStore({ dataDir })` | `pgliteHubStore({ dataDir })` from **`@uncage/hub/node`** |

Everything else (`createHub`, `defineTool`, `postgresHubStore`, `redisCluster`, types) stays in `@uncage/hub`.

### `createHub` requires `store`

0.2 created `pgliteHubStore({ dataDir: './.uncage-hub' })` when `store` was missing. 0.3 throws `createHub: store is required`. Pass `pgliteHubStore(…)` (one Node process) or `postgresHubStore(…)` (several nodes, FaaS).

### `hub.handler` → `hub.fetch`

`hub.handler(req, info?)` is now `hub.fetch(req, info?)`. `info` gained `waitUntil(promise)`, the platform hook for work that may outlive the response (Workers’ `ctx.waitUntil`, Next’s `after`).

### `hub.close()` never closes your store

0.2 closed a store the hub had created. 0.3 never closes `store` (it is always yours): call `await store.close()` after `await hub.close()`. The cluster is still closed only when the hub created it (no `cluster` option). `hub.close()` now also gives running site tool handlers `toolDrainMs` (5 s) to finish.

### Agents must be 0.3 or newer

The connected protocol is now version 2 and `minAgentVersion` defaults to `0.3.0`.

- **Traditional mode:** a 0.2 agent connecting over WebSocket gets `upgrade_required`; 0.2 agents upgrade themselves (`npm i -g @uncage/cli@latest`) and reconnect.
- **FaaS mode:** a 0.2 agent only knows WebSockets, which a FaaS hub does not serve. It gets `426 upgrade_required`, the hub marks the computer as outdated, and the website shows **Agent update needed** with the command to run (`npm i -g @uncage/cli@latest`, then `uncage setup <url>`). `<AgentChat>` shows this by itself (`<AgentOutdatedNotice>`, `MachineInfo.agentOutdated`).

The `install.sh` your hub serves installs `@uncage/cli@^0.3` by default.

### `@uncage/server/wire` no longer exports the Node handler

The Fetch → Node adapter moved to its own subpath: `import { toNodeHandler } from '@uncage/server/node-handler'`. You only used this if you built your own Node adapter; the Local Mode proxy (`@uncage/server/proxy`) is unchanged.

### `UncageError` from `@uncage/core/errors`

`@uncage/core/errors` is a new subpath with just the error helpers (`UncageError`), without the rest of `@uncage/core` (which pulls in Node APIs). Code that runs in a Web-standard bundle (a Worker, a site tool shared with one) should import from there. `@uncage/core` still exports it too.

### `fetchOnce` and `toNextHandlers` (new)

Not breaking, but new mounting helpers in the root entry: `toNextHandlers(hub | promise | getter, { clientIp?, waitUntil? })` returns `{ GET, POST, PATCH, DELETE }` for a Next.js route handler; `fetchOnce(create, req, { clientIp?, waitUntil? })` creates a hub per request where sockets cannot be shared (Workers). `create(defer)` returns a hub or `{ hub, close }`. See [Next.js on Vercel](/docs/deploy/vercel/) and [Cloudflare Workers](/docs/deploy/cloudflare-workers/).

### Rate limits are counted in the store

Device-code, failed-code and the new failed-machine-token limits are now counted in the store, shared by every node and function instance (0.2 counted per node). Nothing to change, unless you implement your own `HubStore` (below). In FaaS mode, give the hub the client IP: without one, every caller shares a single bucket (the hub logs a warning once). `toNextHandlers` does it on Vercel; `fetchOnce` takes `clientIp`.

### `HubStore` gained methods

Only relevant if you wrote your own `HubStore` (the built-in `pgliteHubStore`, `postgresHubStore` and `sqlHubStore` have them). New: the per-machine **links** (`openLink`, `pollLink`, `updateLink`, `closeLink`), the durable **outbox** (`enqueueOutbox`), the upstream **inbox** for deduplication (`claimInbox`, `completeInbox`, `releaseInbox`), **tool-call state** (`claimToolCall`, `finishToolCall`, `getToolCall`, `listStaleToolCalls`, `pruneToolCallResults`), **shared counters** (`hitRateLimit`, `releaseRateLimit`), the **maintenance lease** (`tryLease`), retention (`pruneTransport`) and `markMachineOutdated`, `recordDevicePoll`. Changed: `finishToolCall(id, finish)` now takes the result too (`ToolCallFinish & { result }`) and resolves `boolean` (whether this call's finish won; it used to resolve `void`). `MachineRecord` has a new optional `outdatedAt`. The SQL stores apply their new migrations on start; on Postgres the migrations take a transaction-scoped advisory lock, so they work behind PgBouncer / Neon `-pooler`.

### `hub.maintain()` (new)

`hub.maintain()` runs maintenance now (unless another instance holds the lease) and resolves `{ ran, pruned, interruptedToolCalls }`. You rarely need it: `attachWebSocket` runs it on a timer, and in FaaS mode requests or `GET <basePath>/maintenance` trigger it. A Workers Cron Trigger can call it from `scheduled`.

### `ClusterAdapter.refreshPresence` (optional)

Custom cluster adapters may implement `refreshPresence(machineId, nodeId, ttlSec): Promise<boolean>` (set presence only if absent or already ours, atomically). Without it the hub falls back to check-then-set. `memoryCluster`, `redisCluster` and the new `postgresCluster` implement it.

### Wire and API shapes

- `MachineInfo` has two new fields: `agentOutdated` (boolean) and `transport` (`'ws' | 'http' | null`).
- `GET /machines/install` returns the Windows command in `windows` (`irm https://<site>/api/uncage/install.ps1 | iex`), no longer `null`. The hub also serves `install.ps1`.
- The device token response lists the offered transports; `GET <basePath>/agent/info` (public) does too.
- Custom clients of the agent protocol: see [HTTP API → Agent transport](/docs/reference/http-api/#agent-transport-http-streaming).

## New options

All optional. Full descriptions: [Mount the hub → options](/docs/guides/mount-the-hub/#createhub-options).

| Option | Default | What it does |
| --- | --- | --- |
| `transports` | `['ws', 'http']` with `attachWebSocket`, else `['http']` | Transports offered to agents. |
| `stream.maxDurationMs` | `250000` | The hub ends agent streams **and browser event streams** after this long; clients reconnect at once without a gap. Keep it below your platform’s request time limit. |
| `polling` | `{ activeMs: 300, idleMs: 2000, activeWindowMs: 30000 }` | How often an agent’s HTTP stream polls its outbox. |
| `rateLimits.agentAuthFailuresPerMinute` | `60` | Requests to `/agent/*` with a missing or wrong machine token, per client IP. |
| `maintenance` | `{ intervalMs: 60000 }` | Retention cleanup and failing tool calls of dead instances, at most once per interval across instances. `secret` enables `GET\|POST <basePath>/maintenance` (Vercel Cron); `onRun` adds your own cleanup. |
| `bodyTimeoutMs` | `30000` | A request body not fully received in time is refused with `400`. |
| `toolDrainMs` | `5000` | How long `hub.close()` lets running site tool handlers finish. |
| `installScript` | none | Static extra steps for `install.sh` / `install.ps1`. |
| `postgresCluster({ pool \| connectionString })` | | A `ClusterAdapter` on Postgres: no Redis needed for several nodes or FaaS. |

Retention done by maintenance: run manifests never answered 1 h, others 7 days; hub copies of attachments `attachmentRetentionDays` (30); deduplication rows 24 h; stored tool results 24 h after their call finished; outbox items when they expire; device codes an hour after expiry. In traditional mode `attachWebSocket` runs it every minute; in FaaS mode requests trigger it.

## Behavior changes to know

- **Site tool calls survive dropped connections**: the call and its result are stored, so an agent’s retry gets the stored result instead of a second run (exactly once (on FaaS platforms: when the hub is given the platform's `waitUntil`; see [Workers → FAQ](/docs/deploy/cloudflare-workers/#do-site-tools-run-exactly-once-on-workers))). If the instance running a handler dies, the call fails with “Site tool "<name>" timed out on the website. Please try again.” and is never re-run (at most once). `ctx.signal` now aborts on timeout, when the run ends, or when the hub closes, but no longer when the computer’s connection drops. Details: [Define tools](/docs/guides/define-tools/#when-connections-drop-or-instances-stop).
- **Browser event streams rotate** every `stream.maxDurationMs` (an `event: reconnect` frame). `@uncage/client` resumes with `Last-Event-ID` by itself; custom SSE clients should reconnect on it.
- **Computers can connect over HTTP streaming** when WebSockets fail (three failed attempts), and try WebSocket again every 30 minutes.
- **`<ConnectMachine>` shows one command**: the site's installer in "macOS / Linux" and "Windows" tabs that start on the visitor's OS (`install.windows` is now shown), with `uncage setup <url>` under "Already have the CLI?". The numbered two-step list (`ol.uc-connect-steps`, `.uc-connect-num`) is gone; update any CSS that targets it.

## Checklist

- [ ] All `@uncage/*` packages on 0.3.
- [ ] `toNodeHandler`, `attachWebSocket`, `pgliteHubStore` imported from `@uncage/hub/node`; no `hub.attach`, no `hub.handler`.
- [ ] `store` passed to `createHub`, and closed after `hub.close()`.
- [ ] `pnpm build` / `tsc` green.
- [ ] `curl -s https://your.site/api/uncage/agent/info` shows `"protocol":2`.
- [ ] Users with a 0.2 agent: it upgrades itself (traditional mode), or they follow the **Agent update needed** notice (FaaS mode).
