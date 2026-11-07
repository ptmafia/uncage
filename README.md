# Uncage

**Bring your agent to any app.** Use the harness you trust. Ship the experience you own.

Uncage runs Claude Code (and Codex) as a local, approval-gated agent runtime and gives your web app a typed REST + SSE API, headless React hooks, and a ready-made chat UI. Your app gets streaming answers, tool steps, Allow/Deny approval cards, Stop, reload-safe history, and a composer with model, effort and permission-mode pickers, file and image attachments, and voice input, while the agent keeps running on your own machine under your own login.

> Status: 0.1 (`npm i @uncage/react-ui`), macOS only. Claude Code is verified live (see [docs/compatibility.md](docs/compatibility.md)). Codex is implemented but not yet verified against a real binary (see [Codex status](#codex-status)).

## Quickstart (about 5 minutes)

**1. Prerequisites**

- macOS, Node.js **22 or newer** (`node -v`)
- Claude Code installed and logged in: `npm i -g @anthropic-ai/claude-code`, then run `claude` once and type `/login`
- A Next.js (App Router) app. Starting fresh: `npx create-next-app@latest my-app` (TypeScript, App Router)

**2. Install**

```sh
npm i @uncage/server @uncage/react-ui @uncage/cli
```

**3. Add two files**

The route handler is a same-origin proxy. It reads the daemon token on the server, so the token never reaches the browser.

```ts
// app/api/uncage/[...path]/route.ts
import { createUncageHandler } from '@uncage/server/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST, PATCH } = createUncageHandler();
```

```tsx
// app/page.tsx
'use client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

export default function Page() {
  return (
    <div style={{ height: '100vh' }}>
      <UncageProvider>
        <AgentChat locale="zh-CN" />  {/* or "en" (default) */}
      </UncageProvider>
    </div>
  );
}
```

**4. Start the Uncage daemon** (leave it running, in its own terminal)

```sh
npx uncage serve --workspace /absolute/path/to/the/project/the/agent/works/in
```

`--workspace` is the folder the agent reads and edits. On first start it creates `~/.uncage/token` (mode 600) and `~/.uncage/data`, then prints:

```
Uncage listening on http://127.0.0.1:4783 · workspace /…/project · runtimes: claude ✓, codex ✗ (not installed)
```

Check everything with `npx uncage doctor`: each line is ✓ or ✗, and every ✗ prints the exact `fix:` command. Codex showing "not installed" is fine, it is optional. For a daemon on another port or with its own token file, pass the same flags: `npx uncage doctor --port 4800 --token-file …` (or set `UNCAGE_URL`).

**5. Run your app**

```sh
npm run dev
```

Open http://localhost:3000, pick **Claude Code**, and ask something like "Scan this repo and run the tests". Commands and file edits show an approval card: **Allow once** / **Deny**. **Stop** cancels the run and kills its processes. Refresh any time: `<AgentChat>` keeps the open conversation in `?session=<id>`, so history and pending approvals come back. (`persistSession="localStorage"` keeps the URL clean; `persistSession={false}` turns it off.) Each session is titled after its first prompt.

> **How it fits together.** The browser talks only to your app (`/api/uncage/*`). Your app's server forwards to the daemon on `127.0.0.1:4783` with the token. The daemon runs Claude Code on the same machine, under that machine's Claude login. So the daemon must run on the machine where the agent should work (a developer laptop, a desktop app, an internal box). It is not a multi-tenant cloud service: don't expose it to the internet or share one Claude login among many users.

**Other frameworks.** `createUncageHandler()` returns standard `(Request) => Promise<Response>` handlers, so it also works in any Fetch-style server route (Remix/React Router, SvelteKit, Hono, Bun): `app.all('/api/uncage/*', (c) => h[c.req.method](c.req.raw))` with `const h = createUncageHandler()` in Hono. Mount it under `/api/uncage/*` (or pass `basePath`). The UI packages are plain React 19 components.

**Express, Connect, Fastify, `node:http`.** Use the Node `(req, res, next)` handler. It streams request bodies and SSE without buffering and closes the upstream stream when the browser leaves:

```js
import { createUncageNodeHandler } from '@uncage/server/proxy';
app.use('/api/uncage', createUncageNodeHandler()); // before express.json() and compression()
```

Fastify: `fastify.all('/api/uncage/*', (req, reply) => { reply.hijack(); handler(req.raw, reply.raw); })`, in a plugin with `removeAllContentTypeParsers()` and `addContentTypeParser('*', (_r, _p, done) => done(null))` so the body stays unread. Behind a TLS terminator, set Express `trust proxy` (the Origin check compares the scheme).

**A Vite (or webpack) SPA with a separate backend.** Point the dev server's proxy at your backend and keep the browser's `Host`: `server: { proxy: { '/api': { target: 'http://127.0.0.1:3200', changeOrigin: false } } }`. With `changeOrigin: true` the page loads and lists runtimes, but every POST gets 403 `forbidden_origin` ("Origin http://localhost:5173 does not match Host 127.0.0.1:3200"), because the proxy compares `Origin` with the rewritten `Host`.

**Try it from source instead.** Clone this repo, `pnpm install && pnpm build`, `pnpm uncage serve --workspace …`, then `pnpm --filter nextjs-default-chat dev` for the bundled example (Chinese UI) or `pnpm --filter react-headless-chat dev` for the headless one.

Restyle the UI with the `--uncage-*` CSS variables. All classes use the `uc-` prefix. See [`examples/nextjs-default-chat`](examples/nextjs-default-chat).

## The composer

`<AgentChat>`'s prompt box (Claude Code style) has these controls. Each one really changes what the runtime gets. The live E2E against real Claude Code covers model, effort, the permission modes (including bypass), image and file attachments added with the + button, and the running chip. Drag and drop and paste are covered by the mock E2E. Voice input is [pending manual verification](docs/compatibility.md#voice-input-pending-manual-verification-by-the-user-requires-microphone). See [docs/compatibility.md](docs/compatibility.md).

| Control | What it does |
| --- | --- |
| **Model** (sparkle) | The runtime's own model list. For Claude Code that is `supportedModels()`, with `default` first |
| **Effort** (brain) | `low`, `medium`, `high`, `xhigh`, `max` |
| **Permissions** (shield) | `default` (ask before commands and edits), `acceptEdits` (edit files without asking, still ask for commands), `plan` (plan only, change nothing), `auto` (the runtime decides what needs you). `bypassPermissions` appears only when the server allows it (see below) |
| **Attach** (+), drag and drop, paste | Images show as thumbnails, other files as chips. A pasted screenshot becomes an attachment, pasted text stays text |
| **Voice** (mic) | Dictation through the browser's Web Speech API. Hidden in browsers without it |
| **N running** chip | Runs in progress in any session on this server. Click it to jump to one |
| **Send / Stop** | Enter sends, Shift+Enter is a new line, Enter while an IME is composing never sends. Stop cancels the run |

Settings are stored per session. Before the first prompt they belong to the draft and apply when the session is created. In an open session a change applies **from the next run**. A run in progress and its open approval cards keep the settings it started with.

**Bypass permissions** lets the agent run any command and edit any file without asking. It is off by default and the server never offers it then. A crafted `PATCH` gets 403 `policy_denied`. To allow it, set `security.allowBypass: true` in `uncage.config.yaml` or start the daemon with `UNCAGE_ALLOW_BYPASS=1`. `uncage serve` then prints a warning. Even then, choosing it in the UI asks for confirmation and a red banner stays on while it is active.

> **Warning:** only allow bypass on a machine and workspace you are fine with the agent changing without review. It can delete files and run anything your user account can.

**Attachments.**

- Images: `png jpg jpeg gif webp`. Files: `txt md json csv yaml yml xml html css js ts tsx jsx py go rs java rb sh sql log pdf`.
- At most 10 MB per file and 10 files per message. Claude Code caps images at 5 MB (the Anthropic API's limit).
- Claude gets images inline. Other files are passed by path, and Claude reads them with its tools.
- Uploads are stored in the session's workspace at `<workspace>/.uncage/attachments/<sessionId>/<attachmentId>-<name>`. Uploads that were never sent are deleted after 24 hours.
- `useAttachmentUrl` / `client.attachmentUrl` return a URL under your same-origin proxy (`createUncageHandler`). A plain `<img src>` sends no `Authorization` header, so it only loads because the proxy adds the daemon token on the server; pointed straight at the daemon, it gets 401.
- Uncage writes `.uncage/.gitignore` (`*`) when it creates `.uncage/`, so attachments are never committed. Your own `.gitignore` is never touched. `uncage doctor` warns (non-fatal) when a workspace is a git repo and `.uncage/` is still not ignored.

**Voice privacy.** The browser does the speech recognition, not Uncage. In Chrome the audio goes to Google's speech service. Uncage only ever sees the resulting text in the prompt box. The first use shows a note saying so.

## Custom UI (headless hooks)

Build your own UI with `@uncage/react`. Wrap your app in `<UncageProvider>` and use these hooks. [`examples/react-headless-chat`](examples/react-headless-chat) is a complete chat built only from them.

| Hook | Returns | Use it for |
| --- | --- | --- |
| `useRuntimes()` | `{ runtimes, loading }` | Runtime picker: `status` is `available` / `not_installed` / `auth_required` / …, with `hint` and `installUrl` |
| `useSessions()` | `{ sessions, activeSessionId, loading, select(id), create(body), reload() }` | Session list (newest first), new chat |
| `usePersistSession(mode = 'url')` | `void` | Reopen the last session on reload (`?session=<id>` or `'localStorage'`); `<AgentChat>` does this for you |
| `useSession()` | `{ session, connection, replayIncomplete }` | Header, connection banner |
| `useRun()` | `{ run, isActive, send(prompt), cancel() }` | Composer and Stop button. `send` resolves `true` once the run is accepted |
| `useMessages()` | `{ timeline, messages, tools }` | The conversation |
| `useApprovals()` | `{ pending, all }` | Approval cards |
| `useApprovalActions()` | `{ decide(id, 'allow' \| 'deny'), pending }` | Allow and Deny buttons, with per-card in-flight state |
| `useRuntimeCapabilities(id?)` | `RuntimeCapabilities` | Show only the features a runtime supports |
| `useSessionSettings()` | `{ settings, capabilities, update(patch), pendingForNextRun }` | Model, effort and permission-mode pickers. In a draft they edit the draft, in a session they apply from the next run |
| `useAttachments()` | `{ items, add(files), remove(localId), clear(), ready, rejected }` | Attach button and chips. `add` checks type, size and count, then uploads |
| `useAttachmentUrl(id)` | `string` | `<img src>` for an attachment that was sent with a run |
| `useRunningSessions()` | `{ runs, count }` | "N running" indicator across all sessions (polls every 3 s while the tab is visible) |
| `useSpeechInput({ lang, onText })` | `{ supported, listening, start(), stop(), error }` | Dictation via the Web Speech API |
| `useConnection()` | `'connecting' \| 'live' \| 'reconnecting' \| 'offline'` | Connection indicator |
| `useUncageError()` | `{ error, dismiss }` | Error toast. Every error has a human `message` and a `hint` |

Before the first prompt there is no session yet. Open a draft with `useUncageStore().actions.openDraft(runtimeId)` so settings and files can be picked. Then send with `commitDraft()` (creates the session, applies the draft settings, uploads queued files), then `selectSession(id)`, then `sendPrompt(text)`. The headless example does exactly this.

Lower levels: `@uncage/client` (browser REST + resumable SSE, no React, about 5 KB minified; see its [README](packages/client/README.md) for a vanilla chat), the HTTP API itself (`/v1/*`, typed in `@uncage/protocol`; `POST /sessions/:id/runs` and `POST /approvals/:id/decision` need an `Idempotency-Key` header, e.g. a UUID), or embed the daemon in your own Node process with `createUncage()` (`@uncage/core`) + `createUncageServer()` (`@uncage/server`).

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
- **Tool calls are approved by a person by default.** New sessions use `permissionMode: 'default'`. Claude Code still auto-allows what it considers safe (reads, searches, and some read-only shell commands). Everything else becomes an approval card, and pending approvals expire after 10 minutes. A user can pick `acceptEdits`, `plan` or `auto` per session in the composer. `bypassPermissions` (no approvals at all) is available only when the server opts in with `security.allowBypass` / `UNCAGE_ALLOW_BYPASS=1`; otherwise it is never offered and refused with 403 `policy_denied` (see [The composer](#the-composer)).
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
  allowBypass: false      # true offers the bypassPermissions mode (no approvals). Env: UNCAGE_ALLOW_BYPASS=1
workspace:
  allowedRoots: [/Users/me/code]
  default: /Users/me/code/my-app
runtimes:
  claude: { enabled: true }
  codex: { enabled: true }  # command: [codex, app-server]
```

| CLI | |
| --- | --- |
| `uncage serve [--port n] [--workspace dir] [--data-dir dir] [--token-file file]` | Start the daemon. Env: `UNCAGE_PORT`, `UNCAGE_LOG_LEVEL`, `UNCAGE_ALLOW_BYPASS=1` |
| `uncage doctor [--port n \| --url url] [--workspace dir] [--data-dir dir] [--token-file file]` | Check Node, data dir, token, server and runtimes, with a fix for each failure. Finds the daemon via `--url`, `--port`, `UNCAGE_URL`, then `UNCAGE_PORT`. Warns (`!`, non-fatal) when the daemon's workspace (as it reports it, or `--workspace`) is a git repo that does not ignore `.uncage/`. `uncage <command> --help` lists the flags |
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

The E2E suites and smoke scripts run TypeScript files directly with `node`, so they need **Node 22.18 or newer**, which strips types by default. They use your installed Google Chrome and never download a browser. The live suite starts its own `uncage serve` on a tmp copy of [`e2e/live/fixture-repo`](e2e/live/fixture-repo), with its own data dir and token file, so it leaves `~/.uncage` alone. Its HTML report and traces go to `e2e/live/results/`. For the bypass spec it starts a second `uncage serve` with `UNCAGE_ALLOW_BYPASS=1` on another tmp copy of the fixture.

## Troubleshooting

- **"The Uncage daemon is not reachable" / "token was not found"**: start `npx uncage serve` first. If the daemon was started with `--token-file`, give the app `UNCAGE_TOKEN`.
- **403 `forbidden_origin` in the app**: read the message, it names the header.
  - "Host … is not allowed": the `Host` your browser sends isn't an allowed hostname, for example you opened the `Network:` URL that `next dev` prints, a dev domain, or a tunnel. Add that hostname (without the port) to `allowedHosts` / `UNCAGE_ALLOWED_HOSTS` (see [Security model](#security-model)).
  - "Origin … does not match Host …": something between the browser and your app rewrites `Host`. Vite/webpack dev proxy: `changeOrigin: false`. nginx: `proxy_set_header Host $host;`. The daemon's `allowedOrigins` does not help here, the request never reaches it.
- **Port 4783 in use**: another `uncage serve` is running, or use `--port 4784` and set `UNCAGE_URL=http://127.0.0.1:4784` for the app.
- **Claude Code shows "需要登录" (auth required)**: run `claude`, type `/login`, then restart `uncage serve`.
- Run `npx uncage doctor`. Every failing check prints its fix.
