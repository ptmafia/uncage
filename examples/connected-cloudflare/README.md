# connected-cloudflare

Uncage Connected Mode on **Cloudflare Workers**: a native Worker (no framework) that lets a signed-in
user's own Claude Code call this website's `save_note` tool. Postgres through Hyperdrive is the only
dependency; agents connect over the HTTP streaming transport (Workers serve no WebSocket here).

The help site walks through the same setup for your own Worker, with a checklist and FAQ:
[Cloudflare Workers](https://uncage.vercel.app/docs/deploy/cloudflare-workers/).

| Route | What |
| --- | --- |
| `/api/uncage/*` | The hub (browser API, device login, `install.sh`, agent transport) through `fetchOnce` |
| `GET\|POST /login` | **Demo sign-in, no password** (form posts a name; cookie signed with `DEMO_SECRET`). Refused unless the host is localhost / 127.0.0.1 / [::1] or `ALLOW_DEMO_LOGIN=1`. See [Security](#security) |
| `GET\|POST /device` | Approve the code `uncage setup` prints |
| `GET /notes` | The signed-in user's notes (JSON), written by `save_note` |

> **Security:** the demo sign-in lets anyone become any user. It is off on public hosts by default;
> a real website plugs its own sign-in into `getUser` in `src/hub.ts`. See [Security](#security).

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
cp .dev.vars.example .dev.vars   # then set DEMO_SECRET=$(openssl rand -hex 32) in it
pnpm dev                         # http://localhost:8787
```

Postgres on another port: `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://uncage:uncage@127.0.0.1:<port>/uncage pnpm dev`.

Then sign in at `http://localhost:8787/login` (pick any name), and connect a computer:

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
| `ALLOW_DEMO_LOGIN` | `[vars]`, optional | `1` opens the password-less demo sign-in on a public host. Throwaway demos only |
| `CRON_SECRET` | secret, optional | Enables `GET\|POST /api/uncage/maintenance` with `Authorization: Bearer <secret>` |

## Deploy (not verified on a real Cloudflare account yet)

1. Create the Hyperdrive config and put the printed id into `wrangler.toml` (`[[hyperdrive]] id`):
   ```bash
   pnpm exec wrangler login
   pnpm exec wrangler hyperdrive create uncage --connection-string="postgres://USER:PASSWORD@HOST:5432/DB" --caching-disabled
   ```
   Keep `--caching-disabled`: the hub polls with repeated identical queries, and Hyperdrive's query
   cache would answer them with stale rows (missed commands, stuck streams).
2. Deploy once to create the Worker and learn its URL (requests answer a 500 setup message until
   the secret exists):
   ```bash
   pnpm exec wrangler deploy        # prints https://uncage-connected-cloudflare.<account>.workers.dev
   ```
   (Running `wrangler secret put` before the first deploy also works: it offers to create the Worker.)
3. Set the secret: `openssl rand -hex 32 | pnpm exec wrangler secret put DEMO_SECRET`.
4. Set `PUBLIC_URL` in `wrangler.toml` `[vars]` to that URL (or your custom domain) and deploy again:
   agents and `install.sh` use it, so a wrong value breaks `uncage setup`.
5. Replace the demo sign-in with your own (see [Security](#security)) — on the deployed host
   `/login` is refused unless you set `ALLOW_DEMO_LOGIN = "1"` in `[vars]`.

Without a maintenance secret, requests run the hub's maintenance opportunistically (in the
background through `waitUntil`). With `CRON_SECRET`, a Cron Trigger or any scheduler can call the
maintenance endpoint instead.

## Security

- **`getUser` in `src/hub.ts` is the auth seam.** The hub asks it who sends each browser request;
  return your website's signed-in user (`{ id, name }`) or `null`. Everything else — which machines
  and sessions a user sees, who approves a device code, as whom `save_note` runs — follows from it.
- `src/auth.ts` and `/login` are a **stand-in with no password**: anyone who reaches `POST /login`
  can sign in as any name, see that user's notes and approve devices for them. That is why it only
  answers on localhost / 127.0.0.1 / [::1] unless `ALLOW_DEMO_LOGIN=1`. Delete it in a real site.
- Sign-in is `POST` from the site's own form only (Origin checked; cookie `HttpOnly; SameSite=Lax`,
  `Secure` on https), so another site cannot sign a visitor in as someone else; `/device` decisions
  are `POST` with the same Origin check.
- `DEMO_SECRET` (≥ 32 bytes) signs the cookie; without it every route answers a 500 setup message.

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
- **Why is wrangler pinned to `~4.158.0`?** Every wrangler release since 4.117 depends on a
  prerelease-numbered miniflare 5.x (exact pin); the last one on a stable miniflare (4.116) ships a
  workerd from 2026-07-30, older than this example's `compatibility_date = "2026-10-01"`. The tilde
  keeps the tested wrangler / miniflare / workerd set.
- **Neon / another driver?** Any `pg.Pool`-shaped object works with `postgresHubStore({ pool })`
  and `postgresCluster({ pool })`.
