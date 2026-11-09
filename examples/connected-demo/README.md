# connected-demo: the Uncage Connected Mode reference site

A small website that shows what Connected Mode is for:

- **The website gives the instructions.** A signed-in user types a request in the site's chat.
- **The user's own computer does the work.** The run happens on the user's machine, with their own Claude Code.
- **Claude Code calls the website's tools.** It uses `create_asset` and `publish_asset`, which run inside this website's server as that user.
- **The process and the assets stay on the website.** The conversation is replicated to the site (`sessionStorage: 'site'`), so it stays readable with the computer off. The published page is stored and served by the site.

## One codebase, two entries

The same tools, skill, pages and sign-in run in two modes. The entry that starts the process picks the mode (`lib/mode.ts`); there is no setting for it.

| | Traditional (`server.ts`) | FaaS (Next route handler) |
| --- | --- | --- |
| Start | `pnpm start` / `pnpm dev` (`node server.ts`) | `pnpm start:faas` / `pnpm dev:faas` (`next start` / `next dev`, no custom server), or Vercel |
| Hub mounted by | `toNodeHandler(hub)` + `attachWebSocket(hub, server)` from `@uncage/hub/node` | `app/api/uncage/[[...path]]/route.ts`: `toNextHandlers(getHub, { waitUntil: after })` from `@uncage/hub` |
| Machines connect over | WebSocket (HTTP streaming also offered) | HTTP streaming (a stream rotates every `UNCAGE_STREAM_MAX_MS`, default 250 s, under the route's `maxDuration = 300`) |
| Hub store | PGlite under `DEMO_DATA_DIR`, or Postgres with `DATABASE_URL` | Postgres (`DATABASE_URL`, required; one pool of `DATABASE_POOL_MAX`, default 5, per instance for hub, cluster and assets) |
| Cross-instance messages | in memory, or Redis with `REDIS_URL` | Postgres (`postgresCluster`), or Redis with `REDIS_URL` |
| Assets | files under `DEMO_DATA_DIR/assets`, or Postgres with `DATABASE_URL` | Postgres (`demo_assets`, `demo_asset_files` with `bytea`) |
| Cookie key | `DEMO_SECRET`, else generated into the data dir | `DEMO_SECRET` (at least 32 bytes, required) |
| Public demo cleanup (24 h) | at start and hourly | the hub's maintenance: opportunistic on requests (through `after`), plus Vercel Cron on `/api/uncage/maintenance` (`vercel.json`, `CRON_SECRET`) |
| One publish (`publish_asset`) | up to 20 MB | up to 5 MB (Postgres storage is small and metered) |
| Browser attachments | up to 10 MB | up to 4 MB (Vercel refuses request bodies over ~4.5 MB) |

FaaS mode refuses to start without `DATABASE_URL` and `DEMO_SECRET`, and names what is missing. Nothing is written to local disk. `lib/hub-registry.ts` gives every caller (the route handler, the `/device` page and its Server Action) the one hub of the process: in traditional mode the one `server.ts` published, in FaaS mode one built on first use. Deploying on Vercel: see [DEPLOY.md](DEPLOY.md). The help site explains both modes for your own site: [Choose a deployment mode](https://uncage-dev.vercel.app/docs/start/choose-deployment-mode/), [Node](https://uncage-dev.vercel.app/docs/deploy/node/), [Next.js on Vercel](https://uncage-dev.vercel.app/docs/deploy/vercel/).

In traditional mode, one Node `http` server (`server.ts`) carries everything:

| Path | What |
| --- | --- |
| `/api/uncage/*` | `toNodeHandler(hub)`: the browser API, the device-login endpoints and the installers (`install.sh`, `install.ps1`). Other paths fall through to Next.js. |
| `/api/uncage/agent` | `attachWebSocket(hub, server)`: the WebSocket that users' machines dial into |
| `/` | `<AgentChat>` in Connected Mode. With no computer yet, its empty state is `<ConnectMachine>` (one command per OS, which installs what is missing and runs `uncage setup <this site>`). |
| `/assets` | The user's assets (gallery) |
| `/assets/[id]` | One asset, previewed in `<iframe sandbox="allow-scripts">` |
| `/asset-files/[id]/…` | The published files, sent with a strict CSP (`lib/asset-csp.ts`): `sandbox allow-scripts`, `default-src 'none'`, `connect-src 'none'`; inline styles/scripts plus the asset's own files (`<origin>/asset-files/<id>/`, e.g. `css/app.css`), nothing else. Published means public: anyone with the link can open it (in public demo mode, page requests are owner-only). |
| `/device` | `<ApproveDevice>`, where `uncage setup` sends the user. It sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`, and the decision is a Server Action (a POST that Next.js only accepts from this site's Origin). |
| `/login` | **Demo-only sign-in**: a username in an HMAC-signed cookie, with no password. Replace it with your real authentication; the hub only needs `getUser(req)`. |

### Site tools and the skill

The tools and the skill are in `lib/tools.ts` and `lib/skills.ts`.

- `create_asset({ title, kind: 'landing-page' })` runs without confirmation. It creates a draft owned by the user and returns `assetId`.
- `publish_asset({ assetId, dir })` has `requiresConfirmation`, so the user gets an approval card in the chat. It pulls `dir` from the session workspace on the machine (`ctx.files.pull`, at most 20 MB; 5 MB in FaaS mode), stores the files in the asset store (the data dir, or Postgres) and marks the asset published. A user can only publish their own assets.
- The skill `landing-page` describes the page to build: one folder, `index.html` as the entry, inline CSS and JS, no CDNs or remote resources. Then the agent calls `create_asset` → `publish_asset`. It ends with a short "About Uncage" section of facts (linking `DOCS_URL`, or the public help site), so a page about Uncage describes the real product.

The machine only ever gets the tools' names, descriptions and JSON Schemas, and the skill text. The tool handlers run here.

## Run it (single node)

From the repository root:

```sh
pnpm install && pnpm build          # builds the packages and this app (next build)
cd examples/connected-demo
pnpm start                          # production: http://localhost:3200
# or: pnpm dev                      # Next.js dev mode (HMR) on the same server
```

1. Open http://localhost:3200 and sign in with any username.
2. The chat shows **Connect your computer**. On the same machine, using this repo's CLI:

   ```sh
   node ../../packages/cli/dist/bin.js setup http://localhost:3200 --no-daemon
   node ../../packages/cli/dist/bin.js agent          # foreground; Ctrl-C to stop
   ```

   `setup` opens `/device?code=…`. Check the code and click **批准**. (Without `--no-daemon`, setup installs the agent as a per-user background service: launchd on macOS, systemd on Linux, a scheduled task on Windows.)
3. Send **做一个介绍 Uncage 的落地页并发布**. Claude Code works on your machine, in `~/Uncage/localhost-3200/<session>/`. It calls `create_asset`, writes `landing/index.html` (allow the file-write card), then asks to `publish_asset` (allow it).
4. Open **素材** (`/assets`) to see the published page, rendered in the sandboxed iframe.
5. Stop `uncage agent` and reload the conversation. The whole process is still there, and the header shows the computer offline.

To keep your real `~/.uncage` and `~/Uncage` untouched while trying it, prefix both commands with `UNCAGE_HOME=/tmp/uncage-demo`. `HOME` is not changed, so Claude Code keeps its login.

Environment: `PORT` (3200), `HOST` (127.0.0.1), `PUBLIC_URL` (`http://localhost:$PORT`, the URL users open and give to `uncage setup`), `DEMO_DATA_DIR` (`./.data`: the hub's PGlite store, the assets and the cookie secret), `DEMO_SECRET` (cookie key, at least 32 bytes; shorter values are ignored with a warning; otherwise generated into the data dir), `DATABASE_URL` (Postgres for the hub and the assets instead of the data dir), `TRUST_PROXY=1` / `CLIENT_IP_HEADER=<header>` (where per-IP rate limits find the client behind a proxy; leave both unset without one, see [DEPLOY.md](DEPLOY.md)).

Public demo mode: `DEMO_PUBLIC=1` replaces the sign-in form with a random guest account, shows a banner, makes page requests owner-only (the page's sub-resources are guarded by the unguessable asset id), deletes assets last created or published more than 24 hours ago (traditional: at start and hourly; FaaS: by the hub's maintenance), caps each guest at 20 assets (atomically on Postgres) and all guests together at `DEMO_MAX_TOTAL_MB` of published pages (default 200), and hides Log out (the guest identity is the key to the linked computer). `DOCS_URL` (for example `https://uncage.example/docs/`) adds a link to the docs in the banner. To host it, see [DEPLOY.md](DEPLOY.md).

## Run it (FaaS mode, locally)

The same shape as Vercel: `next start` with no custom server, on one Postgres.

```sh
docker run -d --name uncage-demo-pg -p 127.0.0.1:5434:5432 \
  -e POSTGRES_USER=uncage -e POSTGRES_PASSWORD=uncage postgres:16-alpine
pnpm build
DATABASE_URL=postgres://uncage:uncage@127.0.0.1:5434/uncage \
  DEMO_SECRET="$(openssl rand -base64 48)" PUBLIC_URL=http://localhost:3200 \
  pnpm start:faas -p 3200
```

Then follow the same steps as above. `curl http://localhost:3200/api/uncage/agent/info` lists only the `http` transport. Set `UNCAGE_STREAM_MAX_MS=5000` to watch the agent's stream rotate (`UNCAGE_LOG_LEVEL=info` on the agent logs `http stream rotated`).

## Run it (multi-node)

Two hub nodes share one Postgres (`postgresHubStore`) and one Redis (`redisCluster`). A tiny round-robin proxy (`scripts/rr-proxy.ts`, HTTP and WebSocket, no sticky sessions) sits in front of them, so a machine's WebSocket and the browser's requests usually land on different nodes.

```sh
docker compose up -d                # redis:7-alpine on 127.0.0.1:6380, postgres:16-alpine on 127.0.0.1:5433
pnpm build
HUB_NODES=2 REDIS_URL=redis://127.0.0.1:6380 \
  DATABASE_URL=postgres://uncage:uncage@127.0.0.1:5433/uncage pnpm multinode
# proxy on :3200, nodes on :3201 and :3202
docker compose down                 # when done
```

Then follow the same steps as above against http://localhost:3200. The nodes' log lines are prefixed `[node 1]` / `[node 2]`. The assets are in Postgres (`DATABASE_URL`). Since 0.3 a traditional deployment with `DATABASE_URL` keeps its assets there instead of the shared data dir; assets from an older version's `DEMO_DATA_DIR/assets` are not migrated. The nodes share `DEMO_DATA_DIR` for the generated cookie secret, so run them on one machine or set `DEMO_SECRET`. The hub's rate limits are counted in the store, so every node shares them.

## What to look at

- **`server.ts`**: mounting the hub next to Next.js on one server (request fall-through and WebSocket upgrades).
- **`app/api/uncage/[[...path]]/route.ts`**: the same hub as a Next.js route handler (FaaS mode).
- **`lib/hub.ts`**: `createDemoHub({ mode })`: `createHub` with `tools`, `skills`, `sessionStorage: 'site'`; PGlite or Postgres + Redis in traditional mode, Postgres (+ optional Redis), stream rotation and maintenance in FaaS mode.
- **`lib/assets.ts`**: one `AssetStore` interface, on files or on Postgres.
- **`lib/tools.ts`**: `defineTool`, `requiresConfirmation`, `ctx.user` ownership checks, `ctx.files.pull`, and user-safe error messages.
- **`app/device/*` + `next.config.ts`**: the approval page done safely (no framing, POST via a Server Action, signed-in user only).
- **`app/assets/[id]` + `app/asset-files/…`**: showing agent-written HTML without trusting it.
- In the chat: the computer picker in the header, the approval card for `publish_asset`, and the read-only history with the computer offline.

## Tests

- `pnpm --filter connected-demo test`: cookie signing, CSRF/redirect guards, both asset stores against one contract (Postgres through PGlite), both tools (with a fake `ctx`), the mode rules and the proxy.
- E2E (in `e2e/connected/`, from `e2e/`):
  - `pnpm exec playwright test --project=connected-mock`: real hub + real `uncage setup` (approved on `/device` by Playwright) + the real `@uncage/agent` with the testkit fake runtime.
  - `UNCAGE_DOCKER_TESTS=1 … --project=connected-multinode`: the same on two nodes with throwaway Redis and Postgres containers. It asserts both nodes answered (the proxy's `x-upstream-node` header). Without the variable it is reported as skipped, with the reason.
  - `UNCAGE_DOCKER_TESTS=1 … --project=connected-faas-mock`: FaaS mode — `next start` with no custom server on a throwaway Postgres container, public mode, the agent on HTTP streaming with a stream rotation every 5 s.
  - `UNCAGE_LIVE=1 … --project=connected-live`: real Claude Code, using your Claude login.

  Results are recorded in `docs/compatibility.md`.
