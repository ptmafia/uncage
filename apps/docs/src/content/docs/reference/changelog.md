---
title: Changelog
description: "What changed in each Uncage release: 0.3 (the hub runs anywhere, any ACP agent, macOS / Linux / Windows), 0.2 (Connected Mode) and 0.1. The authoritative changelog is CHANGELOG.md in the repository and on each npm package."
---

All public `@uncage/*` packages share one version. The authoritative record is [`CHANGELOG.md`](https://github.com/ptmafia/uncage/blob/main/CHANGELOG.md) in the repository (and each package’s changelog on npm), written by [Changesets](/docs/guides/ci-and-releases/#releases) at release time.

## 0.3.1 (2026-11-09)

- `@uncage/hub`: importing it from a Next.js page, route handler or Server Action no longer fails with "Can't resolve 'ioredis'" (or `pg`) when those optional packages are not installed.

## 0.3.0 (2026-11-09): the hub runs anywhere

Breaking changes with before/after code: [Migrate from 0.2](/docs/reference/migrate-from-0-2/).

- **Two deployment modes** ([choose one](/docs/start/choose-deployment-mode/)): traditional mode on a long-lived Node server (`toNodeHandler`, `attachWebSocket`, `pgliteHubStore` from `@uncage/hub/node`) and FaaS mode on [Vercel](/docs/deploy/vercel/), [Cloudflare Workers](/docs/deploy/cloudflare-workers/) and [other Fetch platforms](/docs/deploy/other-fetch-platforms/) (`toNextHandlers`, `fetchOnce`, `hub.fetch`) with only Postgres (`postgresHubStore` + `postgresCluster`). The `@uncage/hub` root entry is Web-standard.
- **Connected protocol 2**: computers connect over WebSocket or HTTPS streaming (durable outbox, cursor acks, de-duplication); browser event streams rotate and resume without gaps; site tool calls survive dropped connections.
- **Breaking**: `createHub` requires `store`; `hub.handler` → `hub.fetch`; `hub.attach` → `attachWebSocket`; `hub.close()` never closes your store; agents must be 0.3 or newer.
- **New hub options**: `transports`, `stream.maxDurationMs`, `polling`, `maintenance`, `bodyTimeoutMs` (idle timeout), `logger` (console by default), `toolDrainMs`, `installScript`, `rateLimits.agentAuthFailuresPerMinute`; `hub.maintain()`. Rate limits are counted in the store (fixed windows: a burst across a boundary can reach twice the limit); 429 responses carry `Retry-After`.
- **`@uncage/runtime-acp`** (new): [any ACP agent](/docs/guides/use-any-acp-agent/), auto-detected from the official ACP registry with official icons, run only with the user's consent.
- **One-command installer** for [macOS, Linux and Windows](/docs/start/install-on-your-computer/) with `[Y/n]` prompts, Node.js 22 through the user's own version manager, no `sudo` or admin rights.
- **Browser**: `<ConnectMachine>` with OS tabs, `<AgentOutdatedNotice>`, runtime icons.
- **Examples**: `connected-demo` on Vercel or any container; new `connected-cloudflare`.

## 0.2.0 (2026-11-08): Connected Mode

Connected Mode arrived in 0.2:

- **`@uncage/hub`** (new): the hub for your website’s Node backend. Device login for the CLI, machine WebSockets, the browser API (same shapes as the daemon’s `/v1`), site tools (`defineTool`, executed on the node holding the computer’s connection, as the session owner, zod-validated, 120 s timeout, audited), the file channel (`ctx.files.pull` / `read`), skills, `selectManifest`, `sessionStorage: 'site'` replication, multi-node support with `postgresHubStore` and `redisCluster`, and `attachmentRetentionDays` (default 30) for the hub's attachment copies.
- **`@uncage/agent`** (new): the daemon on the user’s computer. Dials out to one or more hubs (backoff 1 s → 30 s), runs sessions through `@uncage/core` in `~/Uncage/<site>/<session>`, bridges tool calls, serves fenced file pulls, replicates events with backfill, enforces `localPolicy`, keeps a redacted activity log.
- **`@uncage/cli`**: `uncage setup <url>`, `uncage agent` (`uninstall`), `uncage sites` (`remove`), `uncage activity`, and `UNCAGE_HOME` for development.
- **`@uncage/client`, `@uncage/react`, `@uncage/react-ui`**: `machines()`, `installInfo()`, `revokeMachine()`, `createSession({ machineId })`; `useMachines()`; `<ConnectMachine>`, `<ApproveDevice>`, `<MachineStatus>`; `<AgentChat>` switches to Connected Mode by itself. `UncageClient` gains three required methods: custom client implementations must add them.
- **`@uncage/runtime-claude`**: site tools as an in-process MCP server (`mcp__site__<name>`), confirmation tools that always ask, skills written to `.claude/skills` (inline shell in skill markdown is neutralized and `disableSkillShellExecution` is set, so a website can never run shell through a skill). Runtimes without site tools (Codex) get skills only, with a `site_tools_unsupported` warning.
- **`@uncage/protocol`**: the connected wire protocol (version 1), `Session.machineId`, new error codes (`machine_offline`, `machine_not_found`, `upgrade_required`, `tool_failed`, `device_code_expired`, `rate_limited`).
- **`examples/connected-demo`**: the reference website, tested end to end (mock, two nodes with Redis and Postgres, and live with real Claude Code).
- Local Mode is unchanged.

## 0.1.1 (2026-11-07)

- Docs only: npm-first quick start in the README; every package README is self-contained.

## 0.1.0 (2026-11-07)

First public release.

- Local daemon (`uncage serve`) with sessions, runs, events and approvals over HTTP + SSE, PGlite persistence, resumable event replay, approval TTL and single-winner decisions.
- Same-origin proxy for Next.js (`createUncageHandler`) with Host / Origin checks and `allowedHosts`.
- Runtimes: Claude Code via the official Agent SDK (verified live); Codex App Server adapter (verified against a fake app-server only).
- Claude Code–style composer: per-session model, reasoning effort, permission modes (bypass only when the server enables it), image and file attachments, browser voice input, running-sessions chip.
- React: headless hooks (`@uncage/react`) and a default chat UI (`@uncage/react-ui`, `en` / `zh-CN`).
- CLI: `uncage serve`, `uncage doctor`, event export with redaction.
