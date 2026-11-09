# @uncage/agent

## 0.3.1

### Patch Changes

- @uncage/core@0.3.1
  - @uncage/protocol@0.3.1

## 0.3.0

### Minor Changes

- Uncage 0.3: the hub runs anywhere (traditional mode on a Node server, FaaS mode on Vercel, Cloudflare Workers and other Fetch platforms with only Postgres), computers connect over WebSocket or HTTPS streaming (connected protocol 2), any Agent Client Protocol agent can be offered (new `@uncage/runtime-acp`, auto-detected from the ACP registry with consent), and the one-command installer supports macOS, Linux and Windows. Breaking: `@uncage/hub` root is Web-standard (`toNodeHandler`, `attachWebSocket`, `pgliteHubStore` move to `@uncage/hub/node`), `createHub` requires `store`, `hub.handler` → `hub.fetch`, `hub.attach` → `attachWebSocket`, agents must be 0.3 or newer. See https://uncage-dev.vercel.app/docs/reference/migrate-from-0-2/

### Patch Changes

- Updated dependencies
  - @uncage/core@0.3.0
  - @uncage/protocol@0.3.0

## 0.2.0

- New package: the Connected Mode daemon on the user's machine. Dials out to one or more website hubs over WebSocket (backoff 1 s to 30 s), runs their sessions through `@uncage/core` with a per-site data dir and `~/Uncage/<site>/<session>` workspaces.
- Bridges site tool calls, serves fenced file pulls, replicates events with backfill on reconnect (no duplicates), and assembles chunked uploads.
- Local policy in `~/.uncage/agent.yaml`: bypass permissions only if `allowBypass: true`, optional `allowedPermissionModes`; redacted activity log; machine tokens stored 0600 and revocable.
- Honours the hub-chosen session id on `createSession` and records hub run warnings (e.g. `site_tools_unsupported`) as `system.warning` events.
- `uncage setup` clamps the hub's device-login timing (poll interval 1 to 60 s, expiry at most 30 min).
