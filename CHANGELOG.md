# Changelog

## 0.3.0 — 2026-11-09

The hub runs anywhere, any ACP agent can be offered, and the user's side runs on macOS, Linux and Windows. All public `@uncage/*` packages move to 0.3.0 together, including the new `@uncage/runtime-acp`. Breaking changes and before/after code: [Migrate from 0.2](https://uncage-dev.vercel.app/docs/reference/migrate-from-0-2/).

- **Two deployment modes.** Traditional mode (a long-lived Node server: `toNodeHandler` + `attachWebSocket` from `@uncage/hub/node`) and FaaS mode (Vercel, Cloudflare Workers, Netlify, Bun, any Fetch platform: `toNextHandlers`, `fetchOnce`, `hub.fetch`) with only Postgres (`postgresHubStore` + the new `postgresCluster`; Redis optional). The `@uncage/hub` root entry is Web-standard.
- **Connected protocol 2.** Computers connect over WebSocket or HTTPS streaming (NDJSON frames, durable per-computer outbox with cursor acks, inbox de-duplication), falling back to HTTP after three failed WebSocket attempts. Browser event streams rotate every `stream.maxDurationMs` and resume with `Last-Event-ID` without gaps. Site tool calls survive dropped connections (exactly once; at most once if the instance running the handler dies, and on FaaS only when the hub gets the platform's `waitUntil`).
- **Breaking API changes:** `createHub` requires `store`; `hub.handler` → `hub.fetch` (with `waitUntil`); `hub.attach` → `attachWebSocket(hub, server)`; `hub.close()` never closes your store; `@uncage/server/wire` no longer exports the Node handler (`@uncage/server/node-handler`); agents must be 0.3 or newer (`minAgentVersion` defaults to `MIN_AGENT_VERSION`, 0.3.0). Custom `HubStore` implementations need the new link / outbox / inbox / tool-call / rate-limit / lease methods.
- **New hub options:** `transports`, `stream.maxDurationMs`, `polling`, `maintenance` (lease-scheduled retention, optional cron endpoint with a secret), `bodyTimeoutMs` (idle timeout, 4× overall cap), `logger` (warnings and errors go to the console by default; 0.2 was silent), `toolDrainMs`, `installScript`, `rateLimits.agentAuthFailuresPerMinute`; `hub.maintain()`; optional `ClusterAdapter.refreshPresence`.
- **Rate limits are counted in the store**, shared by every node and function instance. They are fixed windows, so a burst across a window boundary can reach up to twice the limit. 429 responses carry `Retry-After`.
- **Any ACP agent** (`@uncage/runtime-acp`, on `@agentclientprotocol/sdk`): Gemini CLI, OpenCode, Claude Code's ACP adapter and others, configured under `runtimes.acp` or auto-detected from the official ACP registry (with its official icons). Registry agents run only with the user's consent bound to the exact command (`uncage runtimes enable`); a project file can never grant it. Permission prompts never pick "allow always"; site tools reach ACP agents through a loopback MCP server with a per-run token; skills are written to `.uncage/skills/`. Claude Code's ACP adapter is verified live.
- **One-command installer for macOS, Linux and Windows** (`install.sh` / `install.ps1`): detects the environment, asks `[Y/n]` before each step, installs Node.js 22 through the user's own version manager (nvm, fnm, Volta, asdf, mise, nvm-windows, …), never uses `sudo` or admin rights, installs the CLI, and offers `uncage setup`. Background service on launchd, systemd `--user` or Task Scheduler. Windows and Linux are CI verified, awaiting real-device confirmation.
- **Browser:** `<ConnectMachine>` shows one installer command with OS tabs; `<AgentOutdatedNotice>` and `MachineInfo.agentOutdated` / `transport`; runtime icons in the picker. The numbered two-step list in `<ConnectMachine>` is gone (update CSS that targeted `ol.uc-connect-steps`).
- **Examples:** `examples/connected-demo` deploys to Vercel (FaaS mode with Postgres) or Railway / any container (traditional mode); new `examples/connected-cloudflare` for Workers with Hyperdrive. Verified end to end with real Claude Code on the Vercel shape (`next start` + Postgres) and on `wrangler dev`.
- Help site: deployment guides for Node, Vercel, Cloudflare Workers and other Fetch platforms, "Choose a deployment mode", "Install on your computer", "Use any ACP agent", and the migration guide, in English, 简体中文 and 日本語.

## 0.2.0 — 2026-11-08

Connected Mode: let a website drive Claude Code on its users' own computers. All public `@uncage/*` packages move to 0.2.0 together.

- New `@uncage/hub` (in your website's Node backend): device login, machine WebSocket, browser API, site tools (`defineTool`, executed as the signed-in user), site skills, a fenced file channel (`ctx.files.pull/read`), attachments up to 10 MiB, `install.sh`, and multi-node operation (`redisCluster`, `postgresHubStore`).
- New `@uncage/agent` (on the user's machine) and CLI commands `uncage setup <url>`, `uncage agent`, `uncage sites`, `uncage activity`, `uncage --version`. Local policy in `~/.uncage/agent.yaml` (bypass only if the user enables it), redacted activity log, revocable machine tokens.
- Browser: `<ConnectMachine>`, `<ApproveDevice>`, `<MachineStatus>`, `useMachines()`, computer picker and offline state in `<AgentChat>`; `client.machines()/installInfo()/revokeMachine()`, `createSession({ machineId })`. Breaking for custom `UncageClient` implementations: three new required methods.
- Codex sessions on sites with tools work: the hub drops the tools for runtimes without site tool support (skills stay) and shows a `site_tools_unsupported` warning; `selectManifest` receives `runtime`.
- Hub attachment copies are deleted after `attachmentRetentionDays` (default 30) and when a machine is revoked. With `sessionStorage: 'site'` the hub only replicates sessions it created.
- `runtime-claude` hardening for site tools and skills (schema complexity guard, destructive-action confirmation, `.claude` symlink fence). Site skills can never run shell: inline `` !`cmd` `` / ```` ```! ```` blocks are neutralized and `disableSkillShellExecution` is set for runs with site skills.
- Local Mode fixes: last session restored on reload, first-prompt session titles with newest-first sorting, clearer proxy 403 messages, `createUncageNodeHandler` for Express/Fastify, `uncage doctor` flags (`--port`, `UNCAGE_URL`), lighter browser client without zod.
- Composer features from 0.1.x stay (model, reasoning effort, permission modes, attachments, voice input).
- Reference site `examples/connected-demo` and a help site for developers and coding agents: https://uncage-dev.vercel.app/docs/

## 0.1.1 — 2026-11-07

- Docs only: npm-first quick start in the README; every package README is now self-contained (install, minimal usage, options) instead of linking to repo paths that npm can't show.

## 0.1.0 — 2026-11-07

First public release.

- Local daemon (`uncage serve`) with Sessions / Runs / Events / Approvals over HTTP + SSE, PGlite persistence, resumable event replay, approval TTL + single-winner decisions.
- Same-origin proxy for Next.js (`createUncageHandler`) with Host / Origin checks and `allowedHosts`.
- Runtimes: Claude Code via the official Agent SDK (verified live); Codex App Server adapter (verified against a fake app-server only).
- Claude Code–style composer: per-session model, reasoning effort, permission modes (bypass only when the server enables it), image/file attachments, browser voice input, running-sessions chip.
- React: headless hooks (`@uncage/react`) and a default chat UI (`@uncage/react-ui`, `en` / `zh-CN`).
- CLI: `uncage serve`, `uncage doctor`, event export with redaction.
