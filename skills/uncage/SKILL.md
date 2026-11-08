---
name: uncage
description: Integrate Uncage into a website or web app, so the site's users can drive Claude Code on their own computers (Connected Mode, @uncage/hub) or the app can drive Claude Code on its own machine (Local Mode, uncage serve). Use when asked to add Uncage, an "agent chat", "connect your computer", site tools for Claude Code, or @uncage/* packages to a project.
---

# Integrate Uncage into a website

Uncage puts Claude Code behind a web UI with streaming, approval cards, Stop and reload-safe history.
Full docs: https://uncage.vercel.app/docs/ (every page also as markdown: add `.md` to the URL;
index: https://uncage.vercel.app/docs/llms.txt; everything: https://uncage.vercel.app/docs/llms-full.txt).

## 1. Pick the mode

- **Connected Mode**: the website has many users, each with their own computer and Claude Code. The
  website mounts `@uncage/hub`; users run the install command once
  (`curl -fsSL https://<site>/api/uncage/install.sh | bash`, Windows: `irm https://<site>/api/uncage/install.ps1 | iex`,
  then `uncage setup https://<site>`); a background agent on their computer dials out to the hub.
  Claude Code (or Codex, or any ACP agent the user has) can call the website's own tools.
  Guide: https://uncage.vercel.app/docs/start/quickstart-connected.md
- **Local Mode**: the app and the agent run on the same machine (internal tool, dev dashboard). Run
  `npx uncage serve --workspace <dir>`; the app adds a same-origin proxy route and `<AgentChat>`.
  Guide: https://uncage.vercel.app/docs/start/quickstart-local.md

If unsure, ask the user: "Will each end user connect their own computer (Connected), or does the agent
run on the same machine as this app (Local)?"

## 2. Connected Mode: pick the deployment mode by platform

Find where the site runs (package.json scripts, `vercel.json`, `wrangler.toml`, `netlify.toml`,
Dockerfile/Procfile, hosting docs) and pick the matching page. Same `createHub` options, tools,
skills and UI in every mode; only `store`, `cluster` and the mount differ.
Comparison: https://uncage.vercel.app/docs/start/choose-deployment-mode.md

| Site runs on | Mode | Mount | Store / cluster | Follow |
| --- | --- | --- | --- | --- |
| A long-running Node server / container (Express, Fastify, Hono, VM, Railway, Fly.io) | traditional | `toNodeHandler(hub)` + `attachWebSocket(hub, server)` from `@uncage/hub/node` | `pgliteHubStore({ dataDir })` (zero deps) | https://uncage.vercel.app/docs/deploy/node.md |
| Next.js, self-hosted with a custom server | traditional | the same, around Next's request handler | `pgliteHubStore` | steps below, https://uncage.vercel.app/docs/start/quickstart-connected.md |
| Next.js on Vercel (or `next start` without a custom server) | FaaS | `toNextHandlers(getHub, { waitUntil: after })` in `app/api/uncage/[...path]/route.ts`, `maxDuration = 300` | `postgresHubStore({ pool })` + `postgresCluster({ pool })` | https://uncage.vercel.app/docs/deploy/vercel.md |
| Cloudflare Workers | FaaS | `fetchOnce(create, req, { waitUntil: ctx.waitUntil.bind(ctx), clientIp: cf-connecting-ip })`, a `pg.Pool` per request via Hyperdrive, `nodejs_compat` | `postgresHubStore` + `postgresCluster` | https://uncage.vercel.app/docs/deploy/cloudflare-workers.md |
| Netlify, Deno, Bun, other Fetch hosts | FaaS | `hub.fetch(req, { clientIp, waitUntil })` | `postgresHubStore` + `postgresCluster` | https://uncage.vercel.app/docs/deploy/other-fetch-platforms.md |

FaaS rules: never import `@uncage/hub/node` there; set `stream.maxDurationMs` below the platform's
request limit (250 000 for Vercel's 300 s) and keep `toolTimeoutMs` inside it; give the hub the client
IP; Postgres via `pg` or a pg-compatible `Pool` (not Neon's HTTP-only `neon()`); pooled URLs are fine.
If unsure, ask: "Where is this website deployed?"

### Traditional mode steps (Next.js App Router with a custom server)

Requirements: a long-running Node server (Node.js 22.18+).

1. `npm i @uncage/hub @uncage/react-ui zod`
2. `lib/auth.ts`: `userFromRequest(req: Request): Promise<{ id: string; name?: string } | null>` for the
   hub, and `currentUser()` for pages. **Wire both to the app's existing sign-in.** Find it first
   (Auth.js `auth()`, Clerk, Lucia, a session cookie lookup). `id` must be stable per user.
3. `lib/tools.ts`: site tools with `defineTool({ name, description, input: z.object(...), handler, requiresConfirmation? })`.
4. `lib/uncage-hub.ts`: `createHub({ publicUrl, getUser: userFromRequest, store: await pgliteHubStore({ dataDir: './.uncage-hub' }), tools, sessionStorage: 'site' })` (`pgliteHubStore` from `@uncage/hub/node`; `store` is required).
5. `lib/hub-registry.ts`: `publishHub(hub)` / `getHub()` through `globalThis` (Next bundles pages separately from `server.ts`).
6. `server.ts`: one `node:http` server; `toNodeHandler(hub)` (from `@uncage/hub/node`) first, falling
   through to Next's handler; `attachWebSocket(hub, server)`; in dev, forward non-hub upgrades to
   `app.getUpgradeHandler()`.
7. `package.json`: `"type": "module"`, `"dev": "node server.ts"`, `"start": "NODE_ENV=production node server.ts"`.
   `tsconfig.json`: `"allowImportingTsExtensions": true` (server-side imports use `.ts` extensions).
8. Chat page (client component): `<UncageProvider><AgentChat /></UncageProvider>` and `import '@uncage/react-ui/styles.css'`, inside a full-height container.
9. `/device` approval page: server component calls `getHub().lookupDevice(code, user)`; a Server Action calls
   `approveDevice` / `denyDevice`; catch errors from `lookupDevice` (e.g. `rate_limited`) and pass them
   to the `error` prop (shown localized, instead of "code not found" when `lookup` is null); a client component renders `<ApproveDevice code lookup state error onApprove onDeny />`.
10. `next.config.ts` headers for `/device` (or all pages): `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`.
11. `.gitignore`: `.uncage-hub/` (the PGlite store folder; keep it on a persistent disk in production).

Copy the exact files from https://uncage.vercel.app/docs/start/quickstart-connected.md; they are
type-checked in CI. Other servers (Express, Fastify, Hono, node:http):
https://uncage.vercel.app/docs/guides/mount-the-hub.md

## 3. Local Mode steps (Next.js App Router)

1. `npm i @uncage/server @uncage/react-ui @uncage/cli`
2. `app/api/uncage/[...path]/route.ts`: `export const runtime = 'nodejs'; export const dynamic = 'force-dynamic'; export const { GET, POST, PATCH } = createUncageHandler();` (from `@uncage/server/proxy`).
3. A page with `<UncageProvider><AgentChat /></UncageProvider>` and the CSS import.
4. Tell the user to run `npx uncage serve --workspace <absolute path>` in a separate terminal.

## 4. Verify (run these and include the output in your report)

Connected Mode, with the dev server running on port 3000:

```sh
curl -s http://localhost:3000/api/uncage/install.sh | head -2          # "#!/usr/bin/env bash" + "# Uncage installer…"
curl -s http://localhost:3000/api/uncage/agent/info                    # "protocol":2; transports ws + http (traditional) or only http (FaaS)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/uncage/health   # 401 when signed out (200 + {"ok":true,…} when signed in)
curl -sI http://localhost:3000/device | grep -iE 'content-security-policy|x-frame-options'   # no ?code=: unknown codes count as failed guesses (rate limited)
npx tsc --noEmit                                                        # the project type-checks
```

FaaS mode: run `next build && next start` (or `wrangler dev`) with a local Postgres in `DATABASE_URL`
before these checks, and run every item of the deploy page's Verify checklist.

End to end (Claude Code signed in; the agent is verified on macOS, CI verified on Linux and Windows):
open the chat page, run the commands it shows, approve the code on `/device`, send a prompt that uses
one of your tools, and check the tool step.

Local Mode:

```sh
npx uncage doctor                                   # every line ✓ (Codex "not installed" is fine)
curl -s http://localhost:3000/api/uncage/runtimes   # JSON array containing "claude", with uncage serve running
```

## 5. Rules and pitfalls

- **Never** add a way for the website to run shell commands or code on the user's computer, and never
  try to enable `bypassPermissions` from the website. Uncage refuses both; only the user can allow
  bypass (`localPolicy.allowBypass` in `~/.uncage/agent.yaml`).
- Mount `toNodeHandler(hub)` **before** body parsers (`express.json()`, compression). Fastify: a scope
  with `removeAllContentTypeParsers()`, `addContentTypeParser('*', (_r, _p, done) => done(null))`,
  `reply.hijack()`, then `handler(req.raw, reply.raw)`.
- Traditional mode: call `attachWebSocket(hub, server)` on the **same** HTTP server that serves
  `publicUrl`. Proxies should forward WebSocket upgrades on `/api/uncage/agent` (agents fall back to
  HTTP streaming otherwise), keep the `Host` header and not buffer SSE or `/api/uncage/agent/stream`.
- `createHub` requires `store`; there is no `hub.attach` or `hub.handler` (0.2 API) — use
  `attachWebSocket` and `hub.fetch`. Upgrading: https://uncage.vercel.app/docs/reference/migrate-from-0-2.md
- `publicUrl` is the exact origin users open (`https://…`). The agent refuses `http://` except for
  localhost, 127.0.0.1 and [::1].
- Tool handlers: scope every read/write to `ctx.user.id`; throw **user-safe** messages (they are shown
  to the user and the model); use `requiresConfirmation: true` for anything that publishes, sends,
  pays or deletes; return small results (under ~1 MiB) and ids/URLs instead of payloads; stay within
  the platform's request time limit (FaaS) and be idempotent where possible (a call whose instance
  dies fails with "Site tool "<name>" timed out on the website. Please try again." and is not re-run).
- Read files from the user's computer with `ctx.files.pull(dir)` / `ctx.files.read(path)` (workspace
  relative, 50 MiB / 10 MiB caps), not through tool arguments. Treat pulled files as untrusted.
- Tool names: `^[a-z][a-z0-9_]{0,47}$`, no `__`. Skill names: `^[a-z][a-z0-9-]{0,47}$`. `SkillSpec` is
  exported by `@uncage/protocol`.
- `selectManifest` returns tool/skill **names**; unknown names are silently ignored.
- Several hub nodes: `postgresHubStore` + `redisCluster` (install `pg`, `ioredis`) or `postgresCluster`
  (no Redis), same config on every node, attach `'error'` listeners to pools/clients you create,
  configure the client IP for rate limits.
- `hub.close()` never closes the store, and closes the cluster only if the hub created it; close yours after it.
- Next.js: start with `node server.ts`, not `next dev` (otherwise `getHub()` throws "The Uncage hub is not running").
- Use the UI words: the user's machine is a "computer" (电脑), the background process is "the agent" (守护进程).
