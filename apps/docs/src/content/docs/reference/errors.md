---
title: Error codes
description: Every Uncage error code with its HTTP status, whether it is retryable, what it means, and what to do, including the Connected Mode codes (machine_offline, tool_failed, upgrade_required, rate_limited).
---

Every error from the hub, the daemon, the proxy or a tool call has the same shape (`ErrorBody` in `@uncage/protocol`):

```json
{ "code": "tool_failed", "message": "…", "hint": "…", "retryable": true, "details": { "reason": "not_in_manifest" }, "requestId": "req_…" }
```

In React, `useUncageError()` returns it as `{ error: { code, message, hint, … } }`; `<AgentChat>` shows the message and hint in the UI language.

| Code | Status | Retry | Meaning and what to do |
| --- | --- | --- | --- |
| `unauthorized` | 401 | no | No signed-in user (`getUser` returned `null`), a missing or wrong daemon token, or an unknown machine token. Sign in; in Local Mode check `UNCAGE_TOKEN`. |
| `forbidden_origin` | 403 | no | A cross-site request to the hub, or the proxy’s `Host` / `Origin` checks failed. The message names the header. See [Troubleshooting](/docs/reference/troubleshooting/#403-forbidden_origin). |
| `not_found` | 404 | no | No such session, run, approval or attachment, **or it belongs to another user**. Also a missing path in `ctx.files.read`, or a tool call for a run the hub does not know (`details.reason: 'run_not_indexed'`). |
| `invalid_request` | 400 | no | The body or parameters do not match the schema. For site tools: arguments did not match `input` (the handler did not run), or a file-channel path left the workspace or named a folder for `read`. |
| `machine_offline` | 409 | yes | The user’s computer is not connected. The UI waits for it; the user should start the agent (`uncage agent`, or check the background service). |
| `machine_not_found` | 404 | no | No such computer for this user, or the user has none yet (“Connect your computer first”). |
| `upgrade_required` | 426 | no | The agent is older than the hub’s `minAgentVersion`. The agent upgrades itself (`npm i -g @uncage/cli@latest`) and reconnects. |
| `tool_failed` | 502 | yes | A site tool call failed: your handler threw (its message is passed on), it timed out (`toolTimeoutMs`), its result was too large, or `details.reason` is `not_in_manifest` or `too_many_concurrent`. |
| `policy_denied` | 403 | no | Refused by policy: `bypassPermissions` without `localPolicy.allowBypass` (Connected) or `security.allowBypass` (Local), or a mode outside `localPolicy.allowedPermissionModes`. |
| `rate_limited` | 429 | yes | Too many device codes from one IP, or too many wrong user codes from one user (`details.retryAfterSec`). |
| `device_code_expired` | 410 | no | The setup code is older than 10 minutes. Run `uncage setup <url>` again. |
| `session_busy` | 409 | yes | The session already has an active run. Wait or Stop it. |
| `session_read_only` | 409 | no | The session can no longer continue (for example Claude Code lost its native session). Start a new one. |
| `approval_expired` | 410 | no | The approval waited more than 10 minutes. Ask again. |
| `approval_already_resolved` | 409 | no | Someone (another tab, another node) decided first. Refresh. |
| `event_replay_unavailable` | 410 | no | The requested events are gone. Fetch a fresh snapshot and resume from its `lastSequence`. |
| `runtime_unavailable` | 503 | no | The runtime (Claude Code, Codex) is not installed on that machine. |
| `auth_required` | 401 | no | The runtime is not signed in. Run `claude`, then `/login`. |
| `unsupported_capability` | 422 | no | The runtime cannot do this, e.g. site tools on a Codex session. |
| `runtime_disconnected` | 502 | yes | The runtime process died mid-run. Start a new run; history is kept. |
| `invalid_workspace` | 400 | no | Local Mode: the workspace is outside `workspace.allowedRoots`. |
| `store_locked` | 423 | yes | Another process uses the same data directory (a second daemon, or two hubs on one PGlite folder). |
| `attachment_too_large` | 413 | no | Over 10 MB (5 MB for images with Claude Code). |
| `attachment_type_unsupported` | 415 | no | Not an allowed image or file type. |
| `internal_error` | 500 | no | A bug or an unexpected failure (also: `selectManifest` threw or picked too many tools). Check the server logs for the `requestId`. |

## Tool errors seen by the model

When a site tool fails, Claude Code receives the error as the tool result and usually tries to recover, so **the message is part of your product**: “No order ord_9 in your account.” helps; “TypeError: cannot read properties of undefined” does not, and may leak internals. See [Define tools → Errors](/docs/guides/define-tools/#errors).
