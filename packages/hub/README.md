# @uncage/hub

The Connected Mode hub, mounted in your website's Node backend: device login for the Uncage CLI,
the WebSocket that users' machines dial into, and the browser API (same shapes as the local daemon's
`/v1`). Sessions run on the user's own machine; the hub routes commands and events, executes your
site tools, and relays attachments.

```ts
import { createHub, toNodeHandler } from '@uncage/hub';

const hub = await createHub({
  publicUrl: 'https://app.example.com',
  getUser: async (req) => sessionUser(req), // your auth: { id } or null
});
app.use('/api/uncage', toNodeHandler(hub));
hub.attach(httpServer); // machine WebSockets at /api/uncage/agent
```

Every `Session` the browser API returns (create, list, snapshot, settings, and `session.*` events)
carries `machineId`, the computer it runs on, so UIs can show that computer's status.

## Site tools

`defineTool` declares a website capability that the agent sees as an MCP tool. The machine gets
only the name, description and JSON Schema (from the zod `input`). The handler runs **on the hub**,
on whichever node holds the machine's connection:

- `ctx.user` is the session owner. The hub checks that the session belongs to this machine and user
  before it calls the handler.
- A run can only call the tools its manifest offered (what `selectManifest` picked when the run
  started, recorded per run in the store). A registered tool left out of the manifest fails with
  `tool_failed` (`details.reason: 'not_in_manifest'`). Calls for runs not started through the hub are
  refused.
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
  ends or the machine disconnects first, the call is dropped. In every case `ctx.signal` aborts.
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

## Storage and clustering

| | single node (default) | several nodes |
|---|---|---|
| `store` | `pgliteHubStore({ dataDir })`: embedded Postgres, one process per data dir | `postgresHubStore({ connectionString } \| { pool })` (needs `pg`) |
| `cluster` | `memoryCluster()`: in-process | `redisCluster({ url } \| { client })` (needs `ioredis`) |

Both stores use the same tables and SQL and meet the same `HubStore` contract. Migrations run on
start; with Postgres they run under an advisory lock, so nodes can start together.

Connection errors: node-postgres emits `'error'` on a pool when an idle connection dies (database
restart, failover), and with no listener that crashes the process. A pool or Redis client the hub
creates (`{ connectionString }`, `{ url }`) gets a listener that logs (`onError`, default
`console.error`). **If you pass your own `{ pool }` or `{ client }`, attach your own `'error'`
listener.** `redisCluster`'s `keyPrefix` (default `uncage:`) prefixes its pub/sub channels as well
as its presence keys, so several deployments can share one Redis.

With several nodes behind a load balancer, a machine's WebSocket lives on one node (A) while browser
requests land anywhere (B):

- B looks up the machine's presence in Redis, publishes the command to A's channel, and A forwards it
  to the machine and publishes the result back.
- Session events fan out over Redis pub/sub.
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

Rate limits (device codes, failed user-code guesses) are counted on each node separately. They are
not shared through the cluster.

### Tests

`pnpm test` runs everything in-process: PGlite, plus `ioredis-mock` for two hub nodes in one
process. `UNCAGE_DOCKER_TESTS=1 pnpm --filter @uncage/hub test` also starts `redis:7-alpine` and
`postgres:16-alpine` with `docker run` on random loopback ports. It runs the store and cluster
contracts and the two-node scenario against them, then removes the containers.
