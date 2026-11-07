---
'@uncage/agent': minor
'@uncage/cli': minor
'@uncage/core': minor
'@uncage/hub': minor
---

Connected Mode agent. New `@uncage/agent`: the daemon on the user's machine that dials out to one
or more website hubs over WebSocket (backoff 1 s → 30 s), runs their sessions through
`@uncage/core` (per-site data dir and `~/Uncage/<site>/<session>` workspaces), bridges site tool
calls, serves fenced file pulls, replicates events with backfill on reconnect, enforces the local
policy (`~/.uncage/agent.yaml`: bypass only if `allowBypass`, optional `allowedPermissionModes`)
and keeps a redacted activity log. New CLI commands: `uncage setup <url>`, `uncage agent`
(`uninstall`), `uncage sites` (`remove`), `uncage activity`. Core: `sessions.create(body, { id })`
and the shared `redactForExport`. Hub: `POST /machine/revoke` (a machine revokes itself).
