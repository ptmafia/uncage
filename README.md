# Uncage

**Bring your agent to any app.** Use the harness you trust. Ship the experience you own.

Uncage runs Claude Code (and Codex) as a local, approval-gated agent runtime and gives your web app a typed REST + SSE API, headless React hooks, and a ready-made chat UI. Your app gets streaming answers, tool steps, Allow/Deny approval cards, Stop, and reload-safe history, while the agent keeps running on your own machine under your own login.

> Status: v0, macOS only. Claude Code is verified live (see [docs/compatibility.md](docs/compatibility.md)). Codex is implemented but not yet verified against a real binary (see [Codex status](#codex-status)).

## Quickstart (about 5 minutes)

**1. Prerequisites**

- macOS, Node.js **22 or newer** (`node -v`), pnpm 10 (`corepack enable`)
- Claude Code installed and logged in: `npm i -g @anthropic-ai/claude-code`, then run `claude` once and type `/login`

**2. Install and build**

```sh
git clone <this repo> uncage && cd uncage
pnpm install && pnpm build
```

**3. Check your setup**

```sh
pnpm uncage doctor
```

Each line is ✓ or ✗, and every ✗ prints the exact `fix:` command. Until you start the server in step 4, "Server reachable" and "Token file" show ✗ with `fix: uncage serve`. That is expected. Codex showing "not installed" is also fine: it is optional.

**4. Start the daemon** (leave it running)

```sh
pnpm uncage serve --workspace /absolute/path/to/your/project
```

`--workspace` is the folder the agent works in. Without it, the agent works in the directory you started the server from, which is this repo. On first start it creates `~/.uncage/token` (mode 600) and `~/.uncage/data`, then prints:

```
Uncage listening on http://127.0.0.1:4783 · workspace /…/your/project · runtimes: claude ✓, codex ✗ (not installed)
```

**5. Open the example chat** (second terminal)

```sh
pnpm --filter nextjs-default-chat dev
```

Open http://localhost:3000 (if port 3000 is busy, Next picks the next free port; open the `Local:` URL it prints), pick **Claude Code**, and ask something like "扫描这个仓库的结构，然后运行 npm test". Commands and file edits show an approval card. Click **允许执行** (Allow) or **拒绝** (Deny). **停止** (Stop) cancels the run and kills its processes.

The example UI is in Chinese (`locale="zh-CN"`). Pass `locale="en"` to `<AgentChat>` for English.

## Add it to your own Next.js app

Two files. The route handler is a same-origin proxy. It reads the daemon token on the server, so the token never reaches the browser.

```ts
// app/api/uncage/[...path]/route.ts
import { createUncageHandler } from '@uncage/server/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST } = createUncageHandler();
```

```tsx
// app/page.tsx
'use client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

export default function Page() {
  return (
    <UncageProvider>
      <AgentChat />
    </UncageProvider>
  );
}
```

See [`examples/nextjs-default-chat`](examples/nextjs-default-chat). Restyle it with the `--uncage-*` CSS variables. All classes use the `uc-` prefix.

## Custom UI (headless hooks)

Build your own UI with `@uncage/react`. Wrap your app in `<UncageProvider>` and use these hooks. [`examples/react-headless-chat`](examples/react-headless-chat) is a complete chat built only from them.

| Hook | Returns | Use it for |
| --- | --- | --- |
| `useRuntimes()` | `{ runtimes, loading }` | Runtime picker: `status` is `available` / `not_installed` / `auth_required` / …, with `hint` and `installUrl` |
| `useSessions()` | `{ sessions, activeSessionId, loading, select(id), create(body), reload() }` | Session list, new chat, opening `?session=<id>` |
| `useSession()` | `{ session, connection, replayIncomplete }` | Header, connection banner |
| `useRun()` | `{ run, isActive, send(prompt), cancel() }` | Composer and Stop button. `send` resolves `true` once the run is accepted |
| `useMessages()` | `{ timeline, messages, tools }` | The conversation |
| `useApprovals()` | `{ pending, all }` | Approval cards |
| `useApprovalActions()` | `{ decide(id, 'allow' \| 'deny'), pending }` | Allow and Deny buttons, with per-card in-flight state |
| `useRuntimeCapabilities(id?)` | `RuntimeCapabilities` | Show only the features a runtime supports |
| `useConnection()` | `'connecting' \| 'live' \| 'reconnecting' \| 'offline'` | Connection indicator |
| `useUncageError()` | `{ error, dismiss }` | Error toast. Every error has a human `message` and a `hint` |

Lower levels: `@uncage/client` (browser REST + resumable SSE, no React), the HTTP API itself (`/v1/*`, typed in `@uncage/protocol`), or embed the daemon in your own Node process with `createUncage()` (`@uncage/core`) + `createUncageServer()` (`@uncage/server`).

## Security model

- **Loopback only.** The daemon binds to `127.0.0.1:4783`. Requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` get 403.
- **Bearer token.** Every `/v1/*` call needs `Authorization: Bearer <token>`. The token is in `~/.uncage/token` (mode 600). It is never logged, never put in events, and never sent to the browser. Without it you get 401.
- **No cross-origin browsers.** A request with an `Origin` header gets 403 unless that origin is listed in `security.allowedOrigins` in `uncage.config.yaml`. The list is empty by default. Browsers talk to the daemon only through your app's same-origin proxy (`createUncageHandler`).
- **The proxy rejects cross-origin requests, too.** A request whose `Origin` differs from the origin the browser is on (the request scheme plus its `Host` header) gets 403 `forbidden_origin`, and so does a non-GET request marked `Sec-Fetch-Site: cross-site`. Loopback names count as one origin when the scheme and port match (`localhost:3000` = `127.0.0.1:3000`).
- **DNS-rebinding guard.** The proxy only answers to allowed hostnames, checked against the browser's `Host` header (Next's `req.url` always carries the server's own hostname, so it can't be used; `X-Forwarded-Host` is ignored). By default these are `localhost`, `127.0.0.1` and `[::1]`, on any port. If your app is served under another hostname (a LAN name, a dev domain, a tunnel), list it:

  ```ts
  createUncageHandler({ allowedHosts: ['app.example.com', 'localhost'] });
  // or: UNCAGE_ALLOWED_HOSTS=app.example.com,localhost
  ```

  The list **replaces** the default, so add the loopback names back if you still use them. Use bare hostnames with no scheme or port: the port of the `Host` header is ignored. Bracket IPv6 addresses (`[::1]`). Entries are trimmed and lowercased. Behind a reverse proxy, make sure it forwards the original `Host` header (e.g. nginx `proxy_set_header Host $host;`), since that is what the check sees.
- **Every tool call is approved by a person.** Claude Code runs with `permissionMode: 'default'`, and `bypassPermissions` cannot be configured. Claude Code still auto-allows what it considers safe (reads, searches, and some read-only shell commands). Everything else becomes an approval card, and pending approvals expire after 10 minutes.
- **Workspaces are fenced.** A session's workspace must resolve (after `realpath`, so symlinks are followed) inside `workspace.allowedRoots`. By default that is the directory `uncage serve` was started in, or the `--workspace` folder.
- **No telemetry.** Logs redact tokens and authorization headers, and they don't contain prompt text at info level. (Next.js, used by the examples, has its own telemetry. Turn it off with `NEXT_TELEMETRY_DISABLED=1`.)

## Configuration

Zero-config works. Optionally add `uncage.config.yaml` in the directory you run `uncage serve` from. Unknown keys are rejected by name.

```yaml
server:
  port: 4783
  eventRetentionDays: 7
security:
  allowedOrigins: []      # origins allowed to call the daemon directly (CORS-style); keep empty with the proxy
  approvalTtlMs: 600000
workspace:
  allowedRoots: [/Users/me/code]
  default: /Users/me/code/my-app
runtimes:
  claude: { enabled: true }
  codex: { enabled: true }  # command: [codex, app-server]
```

| CLI | |
| --- | --- |
| `uncage serve [--port n] [--workspace dir] [--data-dir dir] [--token-file file]` | Start the daemon. Env: `UNCAGE_PORT`, `UNCAGE_LOG_LEVEL` |
| `uncage doctor [--data-dir dir] [--token-file file]` | Check Node, data dir, token, server and runtimes, with a fix for each failure |
| `uncage doctor --export-events <sessionId> [--out file] [--include-content]` | Export a session's events for a bug report (content redacted unless `--include-content`) |

Proxy env (host app): `UNCAGE_URL` (default `http://127.0.0.1:4783`), `UNCAGE_TOKEN` (default: read `~/.uncage/token`), `UNCAGE_ALLOWED_HOSTS`. If you start the daemon with `--token-file`, pass that token to the app as `UNCAGE_TOKEN`.

## Codex status

The Codex adapter (`@uncage/runtime-codex`, which drives `codex app-server` over stdio JSON-RPC) is **implemented, and verified only against a fake app-server**. Its protocol was checked against the official app-server schema, but it has not run against a real `codex` binary. Real-binary details are unverified, for example whether `codex app-server` needs a `--stdio` flag. If you try it, set `runtimes.codex.command` if needed and report what you find. When Codex isn't installed, the UI and `doctor` show it as **not installed** with the hint `npm i -g @openai/codex && codex login`.

## Packages

| Package | What it is |
| --- | --- |
| [`@uncage/cli`](packages/cli) | `uncage serve` / `uncage doctor` |
| [`@uncage/server`](packages/server) | Local daemon (REST + SSE) and the Next.js same-origin proxy |
| [`@uncage/core`](packages/core) | Sessions, runs, approvals, event log (PGlite) |
| [`@uncage/protocol`](packages/protocol) | Wire types, Zod schemas, error catalog |
| [`@uncage/runtime-claude`](packages/runtime-claude) | Claude Code adapter (Claude Agent SDK) |
| [`@uncage/runtime-codex`](packages/runtime-codex) | Codex adapter (app-server JSON-RPC) |
| [`@uncage/client`](packages/client) | Browser transport with resumable SSE |
| [`@uncage/react`](packages/react) | Headless store and hooks |
| [`@uncage/react-ui`](packages/react-ui) | Default chat UI (`<AgentChat>`) |
| [`@uncage/testkit`](packages/testkit) | Fake runtime adapter and adapter contract tests |

## Development

```sh
pnpm build && pnpm typecheck && pnpm lint && pnpm test
pnpm e2e:mock                    # Playwright against a fake runtime (system Chrome)
UNCAGE_LIVE=1 pnpm e2e:live      # Playwright against REAL Claude Code (uses a little Claude usage)
pnpm --filter @uncage/runtime-claude smoke   # one real Claude run, prints the raw SDK messages
```

The E2E suites and smoke scripts run TypeScript files directly with `node`, so they need **Node 22.18 or newer**, which strips types by default. They use your installed Google Chrome and never download a browser. The live suite starts its own `uncage serve` on a tmp copy of [`e2e/live/fixture-repo`](e2e/live/fixture-repo), with its own data dir and token file, so it leaves `~/.uncage` alone. Its HTML report and traces go to `e2e/live/results/`.

## Troubleshooting

- **"The Uncage daemon is not reachable" / "token was not found"**: start `pnpm uncage serve` first. If the daemon was started with `--token-file`, give the app `UNCAGE_TOKEN`.
- **403 `forbidden_origin` in the app**: the `Host` your browser sends isn't an allowed hostname, for example you opened the `Network:` URL that `next dev` prints, a dev domain, or a tunnel. Add that hostname (without the port) to `allowedHosts` / `UNCAGE_ALLOWED_HOSTS` (see [Security model](#security-model)). The error message names the rejected host. Behind a reverse proxy, check that it passes the original `Host` header through.
- **Port 4783 in use**: another `uncage serve` is running, or use `--port 4784` and set `UNCAGE_URL=http://127.0.0.1:4784` for the app.
- **Claude Code shows "需要登录" (auth required)**: run `claude`, type `/login`, then restart `uncage serve`.
- Run `pnpm uncage doctor`. Every failing check prints its fix.
