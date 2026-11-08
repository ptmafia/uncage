# connected-demo: the Uncage Connected Mode reference site

A small website that shows what Connected Mode is for:

- **The website gives the instructions.** A signed-in user types a request in the site's chat.
- **The user's own computer does the work.** The run happens on the user's machine, with their own Claude Code.
- **Claude Code calls the website's tools.** It uses `create_asset` and `publish_asset`, which run inside this website's server as that user.
- **The process and the assets stay on the website.** The conversation is replicated to the site (`sessionStorage: 'site'`), so it stays readable with the computer off. The published page is stored and served by the site.

One Node `http` server (`server.ts`) carries everything:

| Path | What |
| --- | --- |
| `/api/uncage/*` | `toNodeHandler(hub)`: the browser API, the device-login endpoints and `install.sh`. Other paths fall through to Next.js. |
| `/api/uncage/agent` | `hub.attach(server)`: the WebSocket that users' machines dial into |
| `/` | `<AgentChat>` in Connected Mode. With no computer yet, its empty state is `<ConnectMachine>` (install, then `uncage setup <this site>`). |
| `/assets` | The user's assets (gallery) |
| `/assets/[id]` | One asset, previewed in `<iframe sandbox="allow-scripts">` |
| `/asset-files/[id]/…` | The published files, sent with a strict CSP (`lib/asset-csp.ts`): `sandbox allow-scripts`, `default-src 'none'`, `connect-src 'none'`; inline styles/scripts plus the asset's own files (`<origin>/asset-files/<id>/`, e.g. `css/app.css`), nothing else. Published means public: anyone with the link can open it. |
| `/device` | `<ApproveDevice>`, where `uncage setup` sends the user. It sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`, and the decision is a Server Action (a POST that Next.js only accepts from this site's Origin). |
| `/login` | **Demo-only sign-in**: a username in an HMAC-signed cookie, with no password. Replace it with your real authentication; the hub only needs `getUser(req)`. |

### Site tools and the skill

The tools and the skill are in `lib/tools.ts` and `lib/skills.ts`.

- `create_asset({ title, kind: 'landing-page' })` runs without confirmation. It creates a draft owned by the user and returns `assetId`.
- `publish_asset({ assetId, dir })` has `requiresConfirmation`, so the user gets an approval card in the chat. It pulls `dir` from the session workspace on the machine (`ctx.files.pull`, at most 20 MB), stores the files under the demo data dir and marks the asset published. A user can only publish their own assets.
- The skill `landing-page` describes the page to build: one folder, `index.html` as the entry, inline CSS and JS, no CDNs or remote resources. Then the agent calls `create_asset` → `publish_asset`.

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

   `setup` opens `/device?code=…`. Check the code and click **批准**. (Without `--no-daemon`, setup installs the agent as a launchd service on macOS.)
3. Send **做一个介绍 Uncage 的落地页并发布**. Claude Code works on your machine, in `~/Uncage/localhost-3200/<session>/`. It calls `create_asset`, writes `landing/index.html` (allow the file-write card), then asks to `publish_asset` (allow it).
4. Open **素材** (`/assets`) to see the published page, rendered in the sandboxed iframe.
5. Stop `uncage agent` and reload the conversation. The whole process is still there, and the header shows the computer offline.

To keep your real `~/.uncage` and `~/Uncage` untouched while trying it, prefix both commands with `UNCAGE_HOME=/tmp/uncage-demo`. `HOME` is not changed, so Claude Code keeps its login.

Environment: `PORT` (3200), `HOST` (127.0.0.1), `PUBLIC_URL` (`http://localhost:$PORT`, the URL users open and give to `uncage setup`), `DEMO_DATA_DIR` (`./.data`: the hub's PGlite store, the assets and the cookie secret), `DEMO_SECRET` (cookie key, at least 32 bytes; shorter values are ignored with a warning; otherwise generated into the data dir).

Public demo mode: `DEMO_PUBLIC=1` replaces the sign-in form with a random guest account, shows a banner, makes published pages readable by their owner only, and deletes assets older than 24 hours (at start and hourly). `DOCS_URL` (for example `https://uncage.example/docs/`) adds a link to the docs in the banner. To host it, see [DEPLOY.md](DEPLOY.md).

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

Then follow the same steps as above against http://localhost:3200. The nodes' log lines are prefixed `[node 1]` / `[node 2]`. All nodes share `DEMO_DATA_DIR` (assets, cookie secret), so run them on one machine. A real deployment keeps assets in shared storage. The hub's rate limits are counted per node.

## What to look at

- **`server.ts`**: mounting the hub next to Next.js on one server (request fall-through and WebSocket upgrades).
- **`lib/hub.ts`**: `createHub` with `tools`, `skills`, `sessionStorage: 'site'`, and PGlite or Postgres + Redis chosen by env.
- **`lib/tools.ts`**: `defineTool`, `requiresConfirmation`, `ctx.user` ownership checks, `ctx.files.pull`, and user-safe error messages.
- **`app/device/*` + `next.config.ts`**: the approval page done safely (no framing, POST via a Server Action, signed-in user only).
- **`app/assets/[id]` + `app/asset-files/…`**: showing agent-written HTML without trusting it.
- In the chat: the computer picker in the header, the approval card for `publish_asset`, and the read-only history with the computer offline.

## Tests

- `pnpm --filter connected-demo test`: cookie signing, CSRF/redirect guards, the asset store, both tools (with a fake `ctx`) and the proxy.
- E2E (in `e2e/connected/`, from `e2e/`):
  - `pnpm exec playwright test --project=connected-mock`: real hub + real `uncage setup` (approved on `/device` by Playwright) + the real `@uncage/agent` with the testkit fake runtime.
  - `UNCAGE_DOCKER_TESTS=1 … --project=connected-multinode`: the same on two nodes with throwaway Redis and Postgres containers. It asserts both nodes answered (the proxy's `x-upstream-node` header). Without the variable it is reported as skipped, with the reason.
  - `UNCAGE_LIVE=1 … --project=connected-live`: real Claude Code, using your Claude login.

  Results are recorded in `docs/compatibility.md`.
