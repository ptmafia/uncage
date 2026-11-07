# Changelog

## 0.1.0 — 2026-11-07

First public release.

- Local daemon (`uncage serve`) with Sessions / Runs / Events / Approvals over HTTP + SSE, PGlite persistence, resumable event replay, approval TTL + single-winner decisions.
- Same-origin proxy for Next.js (`createUncageHandler`) with Host / Origin checks and `allowedHosts`.
- Runtimes: Claude Code via the official Agent SDK (verified live); Codex App Server adapter (verified against a fake app-server only).
- Claude Code–style composer: per-session model, reasoning effort, permission modes (bypass only when the server enables it), image/file attachments, browser voice input, running-sessions chip.
- React: headless hooks (`@uncage/react`) and a default chat UI (`@uncage/react-ui`, `en` / `zh-CN`).
- CLI: `uncage serve`, `uncage doctor`, event export with redaction.
