---
title: Error codes
description: Every Uncage error code with its HTTP status, whether it is retryable, what it means, and what to do, including the Connected Mode codes (machine_offline, tool_failed, upgrade_required / 426, rate_limited) and the details.reason values (interrupted, link_closed, link_replaced, not_in_manifest, …).
---

Every error from the hub, the daemon, the proxy or a tool call has the same shape (`ErrorBody` in `@uncage/protocol`):

```json
{ "code": "tool_failed", "message": "…", "hint": "…", "retryable": true, "details": { "reason": "not_in_manifest" }, "requestId": "req_…" }
```

In React, `useUncageError()` returns it as `{ error: { code, message, hint, … } }`; `<AgentChat>` shows the message and hint in the UI language.

| Code | Status | Retry | Meaning and what to do |
| --- | --- | --- | --- |
| `unauthorized` | 401 | no | No signed-in user (`getUser` returned `null`), a missing or wrong daemon token, an unknown or revoked machine token, or a wrong maintenance secret. Sign in; in Local Mode check `UNCAGE_TOKEN`; on a computer, run `uncage setup <url>` again. |
| `forbidden_origin` | 403 | no | A cross-site request to the hub, or the proxy’s `Host` / `Origin` checks failed. The message names the header. See [Troubleshooting](/docs/reference/troubleshooting/#403-forbidden_origin). |
| `not_found` | 404 | no | No such session, run, approval or attachment, **or it belongs to another user**. Also a missing path in `ctx.files.read`, or a tool call for a run the hub does not know (`details.reason: 'run_not_indexed'`). |
| `invalid_request` | 400 | no | The body or parameters do not match the schema, a request body is over its limit (1 MiB on the agent routes), or no bytes arrived for `bodyTimeoutMs` (or it took over 4 times that in total). For site tools: arguments did not match `input` (the handler did not run), or a file-channel path left the workspace or named a folder for `read` (`details.reason: 'is_directory'`). Agent transport: `details.reason` `link_replaced`, `link_closed` or `hub_too_old` (below). |
| `machine_offline` | 409 | yes | The user’s computer is not connected. The UI waits for it; the user should start the agent (`uncage agent`, or check the background service). |
| `machine_not_found` | 404 | no | No such computer for this user, or the user has none yet (“Connect your computer first”). |
| `upgrade_required` | 426 | no | The agent is older than the hub’s `minAgentVersion` (0.3.0 by default), or a 0.2 agent tried a WebSocket where none is served (FaaS mode). Over WebSocket the agent upgrades itself (`npm i -g @uncage/cli@latest`) and reconnects; in FaaS mode the website shows “Agent update needed” and the user runs that command, then `uncage setup <url>`. |
| `tool_failed` | 502 | yes | A site tool call failed: your handler threw (its message is passed on), it timed out (`toolTimeoutMs`), it was cancelled (the run ended), its result was too large, or `details.reason` is `not_in_manifest`, `too_many_concurrent` or `interrupted` (the instance running it stopped: “Site tool "<name>" timed out on the website. Please try again.”; never re-run by itself). |
| `policy_denied` | 403 | no | Refused by policy: `bypassPermissions` without `localPolicy.allowBypass` (Connected) or `security.allowBypass` (Local), or a mode outside `localPolicy.allowedPermissionModes`. |
| `rate_limited` | 429 | yes | Too many device codes from one IP, too many wrong user codes from one user, or too many requests with a wrong machine token from one IP (`details.retryAfterSec`). The response carries a `Retry-After` header (seconds, the same value) and the agent waits that long. Counted in the store, for all instances together. |
| `device_code_expired` | 410 | no | The setup code is older than 10 minutes. Run `uncage setup <url>` again. |
| `session_busy` | 409 | yes | The session already has an active run. Wait or Stop it. |
| `session_read_only` | 409 | no | The session can no longer continue (for example Claude Code lost its native session). Start a new one. |
| `approval_expired` | 410 | no | The approval waited more than 10 minutes. Ask again. |
| `approval_already_resolved` | 409 | no | Someone (another tab, another node) decided first. Refresh. |
| `event_replay_unavailable` | 410 | no | The requested events are gone. Fetch a fresh snapshot and resume from its `lastSequence`. |
| `runtime_unavailable` | 503 | no | The runtime (Claude Code, Codex) is not installed on that machine. |
| `auth_required` | 401 | no | The runtime is not signed in. Run `claude`, then `/login`. |
| `unsupported_capability` | 422 | no | The runtime cannot do this, e.g. an attachment type, a setting or an approval option it does not support. (Site tools on a Codex session are not refused: the run starts without them and shows a `site_tools_unsupported` warning.) |
| `runtime_disconnected` | 502 | yes | The runtime process died mid-run. Start a new run; history is kept. |
| `invalid_workspace` | 400 | no | Local Mode: the workspace is outside `workspace.allowedRoots`. |
| `store_locked` | 423 | yes | Another process uses the same data directory (a second daemon, or two hubs on one PGlite folder). |
| `attachment_too_large` | 413 | no | Over 10 MB (5 MB for images with Claude Code). On Vercel, bodies over about 4.5 MB are refused by the platform first, with its own 413. |
| `attachment_type_unsupported` | 415 | no | Not an allowed image or file type. |
| `internal_error` | 500 | no | A bug or an unexpected failure (also: `selectManifest` threw or picked too many tools). Check the server logs for the `requestId`. |

## `details.reason` values

Some codes carry a `details.reason` that tells you more:

| Code | `details.reason` | Meaning |
| --- | --- | --- |
| `tool_failed` | `not_in_manifest` | The tool was not offered to this run (`selectManifest`). |
| `tool_failed` | `too_many_concurrent` | More than `maxConcurrentToolCalls` (8) calls running for one computer on one instance. |
| `tool_failed` | `interrupted` | The hub instance running the handler stopped mid-call (crash, deploy, platform time limit). At most once: not re-run. |
| `not_found` | `run_not_indexed` | A tool call for a run the hub did not start. |
| `invalid_request` | `is_directory` | `ctx.files.read` was given a folder. |
| `invalid_request` | `link_replaced` | Agent transport: a newer `POST /agent/connect` replaced this link. The agent stops this link. |
| `invalid_request` | `link_closed` | Agent transport: the link was closed (for example after a disconnect); the agent connects again. |
| `invalid_request` | `hub_too_old` | Agent transport: the agent speaks a newer protocol than the hub. Update `@uncage/hub`. |

## Warnings in the session

Not errors: the run continues, and the session’s events include a `system.warning` with a code.

| Warning code | Meaning |
| --- | --- |
| `site_tools_unsupported` | The session’s runtime cannot call site tools (Codex today, or an ACP agent with `mcp: off`): the run starts with skills only. |

## Tool errors seen by the model

When a site tool fails, Claude Code receives the error as the tool result and usually tries to recover, so **the message is part of your product**: “No order ord_9 in your account.” helps; “TypeError: cannot read properties of undefined” does not, and may leak internals. See [Define tools → Errors](/docs/guides/define-tools/#errors).
