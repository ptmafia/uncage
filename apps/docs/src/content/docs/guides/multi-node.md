---
title: Multi-node (Redis + Postgres)
description: Run the hub on two or more nodes behind a load balancer with postgresHubStore and redisCluster, what crosses between nodes, load balancer settings, and how to try it locally.
---

One hub node is enough for many deployments. When you need more (availability, rolling deploys, more connections), run the same hub on several nodes behind a load balancer. No sticky sessions are needed.

## What changes

A computer’s WebSocket lives on one node (A). A browser request can land on any node (B). Two shared pieces make that work:

| | One node (default) | Several nodes |
| --- | --- | --- |
| `store` (`HubStore`) | `pgliteHubStore({ dataDir })`: embedded Postgres, one process per data folder | `postgresHubStore({ connectionString })` or `({ pool })`. Needs `pg`. |
| `cluster` (`ClusterAdapter`) | `memoryCluster()`: in-process | `redisCluster({ url })` or `({ client })`. Needs `ioredis`. |

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

- B looks up which node holds the computer (presence in Redis), publishes the command on A’s channel; A forwards it to the computer and publishes the result back.
- Session events fan out to every node over Redis pub/sub, so a browser streaming from any node sees them.
- Site tool calls run on A, the node holding the computer’s connection.
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

Mount it in your server exactly as for one node ([Mount the hub](/uncage/guides/mount-the-hub/)).

- **Migrations** run when the store starts. With Postgres they run under an advisory lock, so nodes can start together.
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

## Load balancer

- **WebSockets** on `<basePath>/agent` must be forwarded (HTTP/1.1 `Upgrade`), with idle timeouts above the 10 s heartbeat. No stickiness needed.
- **SSE** on `<basePath>/sessions/:id/events` must not be buffered, and needs idle timeouts above 15 s (the SSE heartbeat).
- **Host header** preserved, and **client IP** passed on for rate limits: see [behind a proxy](/uncage/guides/mount-the-hub/#behind-a-reverse-proxy-or-load-balancer).
- **Draining:** on deploy, stop sending new requests to a node, then `close()` it. Its computers reconnect to another node with exponential backoff (1 s, growing to at most 30 s); their runs keep going locally meanwhile, and events backfill on reconnect.

## Limits to know

- Rate limits (device codes per IP, failed code guesses per user) are counted **per node**, not shared.
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

Then connect a computer and run a task as in the [quickstart](/uncage/start/quickstart-connected/#9-connect-your-computer-the-users-side), against `http://localhost:3200`. The E2E suite runs this setup too (`UNCAGE_DOCKER_TESTS=1 pnpm exec playwright test --project=connected-multinode` from `e2e/`), and checks that both nodes answered.

The hub’s own tests run the same two-node scenario in one process with `ioredis-mock` (`pnpm --filter @uncage/hub test`), and against real Redis and Postgres containers with `UNCAGE_DOCKER_TESTS=1`.
