---
title: Changelog
description: What changed in each Uncage release, and what is coming in 0.2 (Connected Mode). The authoritative changelog is CHANGELOG.md in the repository and on each npm package.
---

All public `@uncage/*` packages share one version. The authoritative record is [`CHANGELOG.md`](https://github.com/ptmafia/uncage/blob/main/CHANGELOG.md) in the repository (and each package’s changelog on npm), written by [Changesets](/uncage/guides/ci-and-releases/#releases) at release time.

## 0.2.0 (upcoming): Connected Mode

Everything on this site under Connected Mode is new in 0.2:

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
