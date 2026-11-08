# @uncage/core

## 0.2.0

- `sessions.create(body, { id })` so a hub can choose the session id, and the shared `redactForExport`.
- `startRun({ warnings })`: notices recorded as `system.warning` events right after `run.started` (at most 8).
- Local Mode fixes: the session title is the first prompt (trimmed to 60 characters) and sessions sort newest first.
