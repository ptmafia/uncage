# @uncage/hub

## 0.3.0

### Minor Changes

- Uncage 0.3: the hub runs anywhere (traditional mode on a Node server, FaaS mode on Vercel, Cloudflare Workers and other Fetch platforms with only Postgres), computers connect over WebSocket or HTTPS streaming (connected protocol 2), any Agent Client Protocol agent can be offered (new `@uncage/runtime-acp`, auto-detected from the ACP registry with consent), and the one-command installer supports macOS, Linux and Windows. Breaking: `@uncage/hub` root is Web-standard (`toNodeHandler`, `attachWebSocket`, `pgliteHubStore` move to `@uncage/hub/node`), `createHub` requires `store`, `hub.handler` → `hub.fetch`, `hub.attach` → `attachWebSocket`, agents must be 0.3 or newer. See https://uncage-dev.vercel.app/docs/reference/migrate-from-0-2/

### Patch Changes

- Updated dependencies
  - @uncage/core@0.3.0
  - @uncage/protocol@0.3.0
  - @uncage/server@0.3.0

## 0.2.0

- New package. Runs in your website's Node backend (`createHub`, `toNodeHandler`, `hub.attach(server)`): device login for the CLI, the machine WebSocket, and a browser API with the same shapes as the local daemon's `/v1`; every returned `Session` carries `machineId`.
- Site tools: `defineTool` handlers run on the node holding the machine connection, as the session owner, with zod-validated args, a 120 s timeout and an audit table. Site skills (text and templates) are injected per session.
- File channel: `ctx.files.pull/read` reads the session workspace (fenced and size-capped). Attachments up to 10 MiB via chunked frames.
- Multi-node: `redisCluster` and `postgresHubStore` for several hub instances behind a load balancer (memory cluster and `pgliteHubStore` stay the single-node defaults).
- Serves `install.sh` (installs `@uncage/cli@^0.2`), `POST /machine/revoke`, and declares `minAgentVersion`. Optional peers: `ioredis`, `pg`.
- Runtimes without `capabilities.siteTools` (Codex): the hub drops the run's tools (skills stay) and the run shows a `system.warning` (`site_tools_unsupported`) instead of failing. `selectManifest` receives `runtime`.
- Attachment bytes: `attachmentRetentionDays` (default 30, hourly sweep), and a revoked machine's attachments are deleted. The hub keeps this copy for the chat history in both `sessionStorage` modes.
- Site storage replicates only sessions the hub created: `POST /sessions` picks the id and records the session before the machine creates it; events for unknown session ids are ignored and logged (machine storage still indexes them for listing). `HubStore` gains `deleteSession` and `pruneAttachments`; migration 6 adds `sessions.runtime` and `attachments.machine_id/created_at`.
