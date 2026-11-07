# @uncage/hub

## 0.2.0

- New package. Runs in your website's Node backend (`createHub`, `toNodeHandler`, `hub.attach(server)`): device login for the CLI, the machine WebSocket, and a browser API with the same shapes as the local daemon's `/v1`; every returned `Session` carries `machineId`.
- Site tools: `defineTool` handlers run on the node holding the machine connection, as the session owner, with zod-validated args, a 120 s timeout and an audit table. Site skills (text and templates) are injected per session.
- File channel: `ctx.files.pull/read` reads the session workspace (fenced and size-capped). Attachments up to 10 MiB via chunked frames.
- Multi-node: `redisCluster` and `postgresHubStore` for several hub instances behind a load balancer (memory cluster and `pgliteHubStore` stay the single-node defaults).
- Serves `install.sh` (installs `@uncage/cli@^0.2`), `POST /machine/revoke`, and declares `minAgentVersion`. Optional peers: `ioredis`, `pg`.
