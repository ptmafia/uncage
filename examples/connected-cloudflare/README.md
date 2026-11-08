# connected-cloudflare

Uncage Connected Mode on **Cloudflare Workers**: a native Worker (no framework) that lets a signed-in
user's own Claude Code call this website's `save_note` tool. Postgres through Hyperdrive is the only
dependency; agents connect over the HTTP streaming transport (Workers serve no WebSocket here).

| Route | What |
| --- | --- |
| `/api/uncage/*` | The hub (browser API, device login, `install.sh`, agent transport) through `fetchOnce` |
| `GET /login?user=<name>` | Demo sign-in: a cookie signed with `DEMO_SECRET` (HMAC via `crypto.subtle`). Use your real auth instead |
| `GET\|POST /device` | Approve the code `uncage setup` prints |
| `GET /notes` | The signed-in user's notes (JSON), written by `save_note` |

Files: `src/worker.ts` (routes), `src/hub.ts` (`makeHub`, `Env`), `src/tools.ts` (`save_note`,
notes table), `src/skills.ts` (`notes` skill), `src/auth.ts` (demo cookie), `scripts/smoke.ts`.

## How it works on Workers

- **One hub per request.** Workers forbid reusing I/O objects (sockets) across requests, so
  `fetchOnce` builds a `pg.Pool` and a hub for each request and closes both once the response body
  has finished (or the client went away) — never earlier, so the agent's long-lived stream keeps
  working. Everything shared lives in Postgres: `postgresHubStore` + `postgresCluster`.
- **Migrations** are remembered per pool object, and a Worker makes a new pool per request: each
  request pays one cheap `SELECT max(id)` for the store (plus one for the cluster tables when it
  uses them). No lock, no DDL after the first run. The notes table is remembered per connection
  string for the isolate's life.
- **`waitUntil`**: `ctx.waitUntil.bind(ctx)` goes to the hub, so cleanup and background work (and a
  site tool call whose agent POST dropped) outlive the response.
- **Client IP**: Cloudflare sets `cf-connecting-ip`; it is passed as the hub's `clientIp` for the
  per-IP rate limits.
- **`nodejs_compat`** is only for the `pg` driver (sockets through `cloudflare:sockets`). The root
  `@uncage/hub` entry uses Web APIs only; `pnpm build` (`wrangler deploy --dry-run`) bundles it.

## Run it locally (`wrangler dev`, workerd)

Prerequisites: Node ≥ 22.18, pnpm, Docker. From the repository root:

```bash
pnpm install && pnpm build
docker run -d --rm --name uncage-pg -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=uncage -e POSTGRES_PASSWORD=uncage postgres:16-alpine
cd examples/connected-cloudflare
cp .dev.vars.example .dev.vars   # then put a random DEMO_SECRET (>= 32 bytes) in it
pnpm dev                         # http://localhost:8787
```

Postgres on another port: `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://uncage:uncage@127.0.0.1:<port>/uncage pnpm dev`.

Then sign in at `http://localhost:8787/login?user=me`, and connect a computer:

```bash
curl -fsSL http://localhost:8787/api/uncage/install.sh | bash
uncage setup http://localhost:8787
```

## Environment

| Name | Where | What |
| --- | --- | --- |
| `HYPERDRIVE` | `wrangler.toml` `[[hyperdrive]]` | Postgres. `wrangler dev` uses `localConnectionString` |
| `PUBLIC_URL` | `wrangler.toml` `[vars]` | The Worker's public origin (agents and `install.sh` use it) |
| `DEMO_SECRET` | secret / `.dev.vars` | ≥ 32 bytes; signs the demo cookie |
| `CRON_SECRET` | secret, optional | Enables `GET\|POST /api/uncage/maintenance` with `Authorization: Bearer <secret>` |

## Deploy (not verified on a real Cloudflare account yet)

```bash
pnpm exec wrangler hyperdrive create uncage --connection-string="postgres://USER:PASSWORD@HOST:5432/DB"
# put the printed id into wrangler.toml, and PUBLIC_URL = your workers.dev / custom domain URL
pnpm exec wrangler secret put DEMO_SECRET
pnpm exec wrangler deploy
```

Without a maintenance secret, requests run the hub's maintenance opportunistically (in the
background through `waitUntil`). With `CRON_SECRET`, a Cron Trigger or any scheduler can call the
maintenance endpoint instead.

## Verify

- `pnpm test` — routes through `fetchOnce` with a PGlite store (each request's pool ended after the
  response), the device page, `save_note` per owner, and the `wrangler deploy --dry-run` bundle.
- With `pnpm dev` running, against Docker Postgres:

  ```bash
  UNCAGE_HOME=$(mktemp -d) pnpm smoke --runtime fake             # real agent, scripted runtime
  UNCAGE_HOME=$(mktemp -d) pnpm smoke                            # real agent + your Claude Code
  ```

  It checks `install.sh`, that `agent/info` offers only `http`, pairs a throwaway machine through
  `/device`, starts a run that calls `save_note`, reads the SSE events to `run.completed` and finds
  the note on `/notes`. `UNCAGE_HOME` keeps your real `~/.uncage` untouched.

## FAQ

- **Why a pool per request instead of one per isolate?** workerd refuses I/O on a socket opened by
  another request ("Cannot perform I/O on behalf of a different request").
- **Does a long agent stream hit Workers' limits?** Workers limit CPU time, not wall-clock time, and
  a waiting stream uses almost no CPU. The hub still ends each stream after 250 s
  (`stream.maxDurationMs`) and the agent reconnects at once without losing anything.
- **Neon / another driver?** Any `pg.Pool`-shaped object works with `postgresHubStore({ pool })`
  and `postgresCluster({ pool })`.
