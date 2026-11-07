---
'@uncage/hub': minor
'@uncage/agent': minor
'@uncage/protocol': minor
---

Hub: site tools now execute (`defineTool` handlers run on the node holding the machine connection, as the session owner, with zod-validated args, a 120 s timeout and a `uncage_hub_tool_calls` audit table); `ctx.files.pull/read` reads the session workspace over the file channel. Attachments through the hub go up to 10 MiB via chunked `attachment_*` frames. Multi-node: `redisCluster` and `postgresHubStore` (same SQL and contract as `pgliteHubStore`). Agent: assembles chunked uploads; directory pulls skip hard-linked files and list them in `file_done.skipped`.
