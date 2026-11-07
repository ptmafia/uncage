# @uncage/agent

## 0.2.0

- New package: the Connected Mode daemon on the user's machine. Dials out to one or more website hubs over WebSocket (backoff 1 s to 30 s), runs their sessions through `@uncage/core` with a per-site data dir and `~/Uncage/<site>/<session>` workspaces.
- Bridges site tool calls, serves fenced file pulls, replicates events with backfill on reconnect (no duplicates), and assembles chunked uploads.
- Local policy in `~/.uncage/agent.yaml`: bypass permissions only if `allowBypass: true`, optional `allowedPermissionModes`; redacted activity log; machine tokens stored 0600 and revocable.
- Honours the hub-chosen session id on `createSession` and records hub run warnings (e.g. `site_tools_unsupported`) as `system.warning` events.
