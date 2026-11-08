---
name: uncage
description: Integrate Uncage into a website or web app, so the site's users can drive Claude Code on their own computers (Connected Mode, @uncage/hub) or the app can drive Claude Code on its own machine (Local Mode, uncage serve). Use when asked to add Uncage, an "agent chat", "connect your computer", site tools for Claude Code, or @uncage/* packages to a project.
---

# Integrate Uncage into a website

Uncage puts Claude Code behind a web UI with streaming, approval cards, Stop and reload-safe history.
Full docs: https://ptmafia.github.io/uncage/ (every page also as markdown: add `.md` to the URL;
index: https://ptmafia.github.io/uncage/llms.txt; everything: https://ptmafia.github.io/uncage/llms-full.txt).

## 1. Pick the mode

- **Connected Mode**: the website has many users, each with their own computer and Claude Code. The
  website mounts `@uncage/hub` in its Node backend; users run two commands once
  (`curl -fsSL https://<site>/api/uncage/install.sh | bash`, then `uncage setup https://<site>`); a
  background agent on their Mac dials out to the hub. Claude Code can call the website's own tools.
  Guide: https://ptmafia.github.io/uncage/start/quickstart-connected.md
- **Local Mode**: the app and the agent run on the same machine (internal tool, dev dashboard). Run
  `npx uncage serve --workspace <dir>`; the app adds a same-origin proxy route and `<AgentChat>`.
  Guide: https://ptmafia.github.io/uncage/start/quickstart-local.md

If unsure, ask the user: "Will each end user connect their own computer (Connected), or does the agent
run on the same machine as this app (Local)?"

## 2. Connected Mode steps (Next.js App Router)

Requirements: a long-running Node server (Node.js 22.18+). The hub needs WebSocket upgrades, so it
cannot run in serverless functions (Vercel functions); use a custom server or a separate Node service.

1. `npm i @uncage/hub @uncage/react-ui zod`
2. `lib/auth.ts`: `userFromRequest(req: Request): Promise<{ id: string; name?: string } | null>` for the
   hub, and `currentUser()` for pages. **Wire both to the app's existing sign-in.** Find it first
   (Auth.js `auth()`, Clerk, Lucia, a session cookie lookup). `id` must be stable per user.
3. `lib/tools.ts`: site tools with `defineTool({ name, description, input: z.object(...), handler, requiresConfirmation? })`.
4. `lib/uncage-hub.ts`: `createHub({ publicUrl, getUser: userFromRequest, tools, sessionStorage: 'site' })`.
5. `lib/hub-registry.ts`: `publishHub(hub)` / `getHub()` through `globalThis` (Next bundles pages separately from `server.ts`).
6. `server.ts`: one `node:http` server; `toNodeHandler(hub)` first, falling through to Next's handler;
   `hub.attach(server)`; in dev, forward non-hub upgrades to `app.getUpgradeHandler()`.
7. `package.json`: `"type": "module"`, `"dev": "node server.ts"`, `"start": "NODE_ENV=production node server.ts"`.
   `tsconfig.json`: `"allowImportingTsExtensions": true` (server-side imports use `.ts` extensions).
8. Chat page (client component): `<UncageProvider><AgentChat /></UncageProvider>` and `import '@uncage/react-ui/styles.css'`, inside a full-height container.
9. `/device` approval page: server component calls `getHub().lookupDevice(code, user)`; a Server Action calls
   `approveDevice` / `denyDevice`; catch errors from `lookupDevice` (e.g. `rate_limited`) and pass them
   to the `error` prop (shown localized, instead of "code not found" when `lookup` is null); a client component renders `<ApproveDevice code lookup state error onApprove onDeny />`.
10. `next.config.ts` headers for `/device` (or all pages): `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`.
11. `.gitignore`: `.uncage-hub/` (the default PGlite store).

Copy the exact files from https://ptmafia.github.io/uncage/start/quickstart-connected.md; they are
type-checked in CI. Other servers (Express, Fastify, Hono, node:http):
https://ptmafia.github.io/uncage/guides/mount-the-hub.md

## 3. Local Mode steps (Next.js App Router)

1. `npm i @uncage/server @uncage/react-ui @uncage/cli`
2. `app/api/uncage/[...path]/route.ts`: `export const runtime = 'nodejs'; export const dynamic = 'force-dynamic'; export const { GET, POST, PATCH } = createUncageHandler();` (from `@uncage/server/proxy`).
3. A page with `<UncageProvider><AgentChat /></UncageProvider>` and the CSS import.
4. Tell the user to run `npx uncage serve --workspace <absolute path>` in a separate terminal.

## 4. Verify (run these and include the output in your report)

Connected Mode, with the dev server running on port 3000:

```sh
curl -s http://localhost:3000/api/uncage/install.sh | head -2          # "#!/usr/bin/env bash" + "# Uncage installer…"
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/uncage/health   # 401 when signed out (200 + {"ok":true,…} when signed in)
curl -sI http://localhost:3000/device | grep -iE 'content-security-policy|x-frame-options'   # no ?code=: unknown codes count as failed guesses (rate limited)
npx tsc --noEmit                                                        # the project type-checks
```

End to end (needs macOS, Claude Code signed in): open the chat page, run the two commands it shows,
approve the code on `/device`, send a prompt that uses one of your tools, and check the tool step.

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
- Call `hub.attach(server)` on the **same** HTTP server that serves `publicUrl`. Proxies must forward
  WebSocket upgrades on `/api/uncage/agent`, keep the `Host` header and not buffer SSE.
- `publicUrl` is the exact origin users open (`https://…`). The agent refuses `http://` except for
  localhost, 127.0.0.1 and [::1].
- Tool handlers: scope every read/write to `ctx.user.id`; throw **user-safe** messages (they are shown
  to the user and the model); use `requiresConfirmation: true` for anything that publishes, sends,
  pays or deletes; return small results (under ~1 MiB) and ids/URLs instead of payloads.
- Read files from the user's computer with `ctx.files.pull(dir)` / `ctx.files.read(path)` (workspace
  relative, 50 MiB / 10 MiB caps), not through tool arguments. Treat pulled files as untrusted.
- Tool names: `^[a-z][a-z0-9_]{0,47}$`, no `__`. Skill names: `^[a-z][a-z0-9-]{0,47}$`. `SkillSpec` is
  exported by `@uncage/protocol`.
- `selectManifest` returns tool/skill **names**; unknown names are silently ignored.
- Several hub nodes: `postgresHubStore` + `redisCluster` (install `pg`, `ioredis`), same config on every
  node, attach `'error'` listeners to pools/clients you create, configure the client IP for rate limits.
- `hub.close()` only closes a store/cluster the hub created; close yours after it.
- Next.js: start with `node server.ts`, not `next dev` (otherwise `getHub()` throws "The Uncage hub is not running").
- Use the UI words: the user's machine is a "computer" (电脑), the background process is "the agent" (守护进程).
