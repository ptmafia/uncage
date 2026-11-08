---
title: Multi-node (Postgres, Redis)
description: Run the hub on two or more nodes behind a load balancer with postgresHubStore and redisCluster or postgresCluster, why FaaS mode is multi-instance by nature, what crosses between nodes and what is guaranteed, load balancer settings, and how to try it locally.
---

One hub node is enough for many deployments. When you need more (availability, rolling deploys, more connections), run the same hub on several nodes behind a load balancer. No sticky sessions are needed.

**FaaS mode is multi-node by nature**: every function instance is a hub node, instances start and stop at any time, and any of them may serve any request. Everything on this page applies there too; the deploy pages ([Vercel](/docs/deploy/vercel/), [Workers](/docs/deploy/cloudflare-workers/)) already use `postgresHubStore` + `postgresCluster`.

## What changes

A computer’s WebSocket lives on one node (A). A browser request can land on any node (B). Two shared pieces make that work:

| | One node (default) | Several nodes |
| --- | --- | --- |
| `store` (`HubStore`) | `pgliteHubStore({ dataDir })`: embedded Postgres, one process per data folder | `postgresHubStore({ connectionString })` or `({ pool })`. Needs `pg`. |
| `cluster` (`ClusterAdapter`) | `memoryCluster()`: in-process | `redisCluster({ url })` or `({ client })` (needs `ioredis`), or `postgresCluster({ pool })` / `({ connectionString })` on the same Postgres (no Redis). |

```mermaid
flowchart LR
  B["Browser"] --> LB["Load balancer"]
  M["User's computer"] -- "WSS" --> LB
  LB --> N1["Hub node A<br/>holds the computer's socket"]
  LB --> N2["Hub node B<br/>serves the browser request"]
  N1 <-- "presence, commands,<br/>results, events" --> R[("Redis")]
  N2 <--> R
  N1 --> P[("Postgres")]
  N2 --> P
```

- B looks up which node holds the computer (presence in the cluster), publishes the command on A’s channel; A forwards it to the computer and publishes the result back. A computer on HTTP streaming is not tied to a node: B writes the command to the computer’s outbox in the store and wakes its stream through the cluster.
- Session events fan out to every node over the cluster, so a browser streaming from any node sees them.
- Site tool calls run on the node that receives them: A for a WebSocket, whichever node gets the agent’s POST for HTTP streaming.
- An approval decided on B reaches the computer exactly once. The computer is the single judge: if two decisions race, the second gets `409`.

## Set it up

```sh
npm i pg ioredis
```

```ts title="hub.ts"
import { createHub, postgresHubStore, redisCluster, type HubUser } from '@uncage/hub';

declare function getUser(req: Request): Promise<HubUser | null>;

const store = await postgresHubStore({ connectionString: process.env.DATABASE_URL! });
const cluster = redisCluster({ url: process.env.REDIS_URL! });

export const hub = await createHub({
  publicUrl: 'https://app.example.com', // the same on every node
  getUser,
  store,
  cluster,
  sessionStorage: 'site',
});

/** On shutdown: the hub closes only what it created, so close the store and cluster after it. */
export async function closeHub(): Promise<void> {
  await hub.close();
  await cluster.close();
  await store.close();
}
```

Mount it in your server exactly as for one node ([Mount the hub](/docs/guides/mount-the-hub/)).

- **Migrations** run when the store starts. With Postgres they run in one transaction under a transaction-scoped advisory lock, so nodes can start together, also behind a transaction-mode pooler (PgBouncer, Neon `-pooler`).
- **Every node must have the same configuration:** `publicUrl`, `basePath`, `site`, `tools`, `skills`, `selectManifest`, `sessionStorage`. A tool call runs on whichever node holds the computer’s socket, so every node needs every tool.
- **Share a Redis between deployments** (staging and production, say) with different `keyPrefix` values: `redisCluster({ url, keyPrefix: 'myapp-staging:' })`. The default is `uncage:`. It prefixes both the presence keys and the pub/sub channels.

### Your own pool or client

```ts title="own-clients.ts"
import { postgresHubStore, redisCluster } from '@uncage/hub';
import { Redis } from 'ioredis';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
pool.on('error', (err) => console.error('postgres pool error', err)); // required: see below
const redis = new Redis(process.env.REDIS_URL!);
redis.on('error', (err) => console.error('redis error', err));

export const store = await postgresHubStore({ pool });
export const cluster = redisCluster({ client: redis, keyPrefix: 'myapp:' });
```

node-postgres emits `'error'` on a pool when an idle connection dies (a database restart or failover). With no listener, that crashes the process. A pool or client the hub creates itself (`{ connectionString }`, `{ url }`) gets a listener that logs (the `onError` option, default `console.error`). **If you pass your own `pool` or `client`, attach your own `'error'` listener.**

### Without Redis: `postgresCluster`

`postgresCluster` carries the cluster messages through a table in the same Postgres, so one database is all you run:

```ts title="pg-cluster.ts"
import { createHub, postgresCluster, postgresHubStore, type HubUser } from '@uncage/hub';
import pg from 'pg';

declare function getUser(req: Request): Promise<HubUser | null>;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
pool.on('error', (err) => console.error('postgres pool error', err));

export const hub = await createHub({
  publicUrl: 'https://app.example.com',
  getUser,
  store: await postgresHubStore({ pool }),
  cluster: postgresCluster({ pool }), // one pool for both
});
```

How it behaves, so you can choose:

- **Polling, not push.** Each node polls the messages table every 300 ms while there is traffic and backs off to every 2 s when quiet (`activePollMs`, `idlePollMs`, `activeWindowMs`). It needs no `LISTEN/NOTIFY`, so it works through any pooler and serverless driver. Expect up to about 2 s extra before an idle node reacts; Redis delivers at once.
- **At most once, with a bounded gap.** A message whose transaction commits late is waited for up to 2 s (`gapTimeoutMs`) before a reader moves past it. A message lost that way is never delivered twice: a command then fails with a timeout on the website (the user retries), and browser event streams backfill from the store.
- **Your database stays awake.** A long-lived node polls at least every 2 s, forever. With a scale-to-zero database (Neon, for example) that means it never suspends while a node runs. Use Redis if that matters.
- **Retention.** Messages older than 60 s (`retentionMs`) are deleted by any node every 30 s.

Rule of thumb: `postgresCluster` for FaaS mode and small deployments (one less service); `redisCluster` for many nodes, low latency, or a database that should be able to sleep.

## Load balancer

- **WebSockets** on `<basePath>/agent` must be forwarded (HTTP/1.1 `Upgrade`), with idle timeouts above the 10 s heartbeat. No stickiness needed.
- **Streams**: SSE on `<basePath>/sessions/:id/events` and NDJSON on `<basePath>/agent/stream` must not be buffered, and need idle timeouts above 15 s (the heartbeats) and request timeouts above `stream.maxDurationMs` (250 s).
- **Host header** preserved, and **client IP** passed on for rate limits: see [behind a proxy](/docs/guides/mount-the-hub/#behind-a-reverse-proxy-or-load-balancer).
- **Draining:** on deploy, stop sending new requests to a node, then `close()` it. Its computers reconnect to another node with exponential backoff (1 s, growing to at most 30 s); their runs keep going locally meanwhile, and events backfill on reconnect.

:::caution[Client IP behind the load balancer]
`POST <basePath>/device/code` is limited to 20 per minute **per client IP**, counted in the store for all nodes together. Behind a load balancer every request comes from the balancer's address unless you set `app.set('trust proxy', <hops>)` (Express, with `toNodeHandler`), `rateLimits.clientIp(req)`, or `rateLimits.trustForwardedFor: true`. Without one of them all users share one bucket and `uncage setup` starts failing with `429 rate_limited` as soon as about 20 people connect in the same minute.
:::

## Limits to know

- Rate limits (device codes per IP, failed code guesses per user, failed machine tokens per IP) are counted in the store, so they are shared by every node. The per-IP limits need the real client IP (see the caution above).
- `pgliteHubStore` cannot be shared between processes: it takes a lock on its data folder. Several nodes must use Postgres.

## Try it locally

The reference demo has a two-node mode with a small round-robin proxy in front (no stickiness), so the computer and the browser usually land on different nodes:

```sh
cd examples/connected-demo
docker compose up -d                # redis:7-alpine on 127.0.0.1:6380, postgres:16-alpine on 127.0.0.1:5433
pnpm build
HUB_NODES=2 REDIS_URL=redis://127.0.0.1:6380 \
  DATABASE_URL=postgres://uncage:uncage@127.0.0.1:5433/uncage pnpm multinode
# proxy on :3200, nodes on :3201 and :3202
docker compose down                 # when done
```

Then connect a computer and run a task as in the [quickstart](/docs/start/quickstart-connected/#9-connect-your-computer-the-users-side), against `http://localhost:3200`. The E2E suite runs this setup too (`UNCAGE_DOCKER_TESTS=1 pnpm exec playwright test --project=connected-multinode` from `e2e/`), and checks that both nodes answered.

The hub’s own tests run the same two-node scenario in one process with `ioredis-mock` (`pnpm --filter @uncage/hub test`), and against real Redis and Postgres containers with `UNCAGE_DOCKER_TESTS=1`.
