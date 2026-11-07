# Changelog

## 0.2.0 — 2026-11-08

Connected Mode: let a website drive Claude Code on its users' own computers. All public `@uncage/*` packages move to 0.2.0 together.

- New `@uncage/hub` (in your website's Node backend): device login, machine WebSocket, browser API, site tools (`defineTool`, executed as the signed-in user), site skills, a fenced file channel (`ctx.files.pull/read`), attachments up to 10 MiB, `install.sh`, and multi-node operation (`redisCluster`, `postgresHubStore`).
- New `@uncage/agent` (on the user's machine) and CLI commands `uncage setup <url>`, `uncage agent`, `uncage sites`, `uncage activity`, `uncage --version`. Local policy in `~/.uncage/agent.yaml` (bypass only if the user enables it), redacted activity log, revocable machine tokens.
- Browser: `<ConnectMachine>`, `<ApproveDevice>`, `<MachineStatus>`, `useMachines()`, computer picker and offline state in `<AgentChat>`; `client.machines()/installInfo()/revokeMachine()`, `createSession({ machineId })`. Breaking for custom `UncageClient` implementations: three new required methods.
- `runtime-claude` hardening for site tools and skills (schema complexity guard, destructive-action confirmation, `.claude` symlink fence).
- Local Mode fixes: last session restored on reload, first-prompt session titles with newest-first sorting, clearer proxy 403 messages, `createUncageNodeHandler` for Express/Fastify, `uncage doctor` flags (`--port`, `UNCAGE_URL`), lighter browser client without zod.
- Composer features from 0.1.x stay (model, reasoning effort, permission modes, attachments, voice input).
- Reference site `examples/connected-demo` and a help site for developers and coding agents: https://ptmafia.github.io/uncage/

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
