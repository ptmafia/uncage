---
title: HTTP API
description: Every route of the hub's browser API, device endpoints and installer, how they map to the Local Mode daemon's /v1 API, request bodies, headers, SSE, and error responses.
---

You rarely call these yourself: `@uncage/client` (and the React packages on top of it) does. They are listed here for custom clients, debugging and coding agents. Types for every body are in `@uncage/protocol`.

## Two servers, one API shape

| | Connected Mode hub | Local Mode daemon |
| --- | --- | --- |
| Base | `<publicUrl><basePath>` (default `/api/uncage`) | `http://127.0.0.1:4783/v1`, reached through your proxy at `/api/uncage` |
| Auth | Your cookies, via `getUser(req)` | `Authorization: Bearer <token>`, added by the proxy |
| Extra | `/machines`, device endpoints, `install.sh`, the agent WebSocket | none |

The session, run, event and approval routes have the same request and response shapes in both. That is why the same client works against either: point it at `/api/uncage` and it talks to the hub or to the proxy.

## Browser API

All routes below need a signed-in user (`401 unauthorized` otherwise). Resources of another user answer `404`, the same as missing ones. Non-GET requests from another origin get `403 forbidden_origin`.

| Method and path | Body / query | Answer |
| --- | --- | --- |
| `GET /health` | | `{ ok: true, protocol: "1.0", version }` |
| `GET /runtimes` | `?machineId=` (optional) | `RuntimeInfo[]` of that computer, else of the first online one |
| `GET /machines` | | `MachineInfo[]`: `{ id, name, os, agentVersion, runtimes, online, lastSeenAt }`, most recently seen first |
| `GET /machines/install` | | `{ install, setup, windows: null }`: the two commands to show |
| `DELETE /machines/:id` | | `{ ok: true }`. Revokes the computer |
| `GET /sessions` | | `Session[]`, each with `machineId`, oldest first |
| `POST /sessions` | `{ runtime, title?, machineId? }` | `201 Session`. Without `machineId`: the most recently seen online computer. `workspace` is ignored |
| `GET /sessions/:id` | | `SessionSnapshot`: `{ session, runs, pendingApprovals, lastSequence }` |
| `PATCH /sessions/:id/settings` | `{ model?, effort?, permissionMode? }` (at least one) | `Session` |
| `POST /sessions/:id/runs` | `{ prompt, attachmentIds? }` + header `Idempotency-Key` | `202 Run` |
| `GET /sessions/:id/events` | `?after=<sequence>` or header `Last-Event-ID` | SSE stream of `UncageEvent`s. With `Accept: application/json`: a JSON array (`?limit=`) |
| `POST /sessions/:id/attachments` | raw bytes; headers `Content-Type`, `X-Filename` (URI-encoded) | `Attachment`. At most 10 MiB |
| `GET /attachments/:id` | | The file |
| `GET /runs?active=1` | | `ActiveRunInfo[]`: runs in progress in the user’s sessions |
| `GET /runs/:id` | | `Run` |
| `POST /runs/:id/cancel` | | `202` |
| `GET /approvals?sessionId=` | | Pending `ApprovalRequest[]` of that session |
| `POST /approvals/:id/decision` | `{ decision: "allow" \| "deny", scope: "once" \| "session", reason? }` + header `Idempotency-Key` | The updated `ApprovalRequest`. A second, different decision gets `409` |

The Local Mode daemon has the same routes under `/v1` except `/machines*`, and accepts `workspace` in `POST /v1/sessions` (inside its allowed roots).

### Server-sent events

`GET /sessions/:id/events` streams `text/event-stream`. Each event carries its sequence as the SSE `id`, so a reconnecting `EventSource` (or `@uncage/client`) resumes with `Last-Event-ID`. Comment lines are sent every 15 s (`sseHeartbeatMs`) to keep proxies from closing the stream. Events you will see: `session.created`, `session.updated`, `run.started`, `run.updated`, `run.completed`, `run.failed`, `run.cancelled`, `run.interrupted`, `message.started`, `message.delta`, `message.completed`, `tool.started`, `tool.updated`, `tool.completed`, `tool.failed`, `approval.requested`, `approval.updated`, `approval.resolved`, `system.warning`.

## Machine side (public)

Used by the CLI and the agent. They do not call `getUser`.

| Method and path | |
| --- | --- |
| `GET /install.sh` | The installer (`text/plain`). Fixed content; only the CLI version range varies |
| `POST /device/code` | Starts a device login. Answers the user code, the verification link, the polling interval (2 s) and the expiry (600 s). Rate limited per client IP |
| `POST /device/token` | `{ deviceCode }`: polls until the user approves; then answers the machine token once |
| `POST /machine/revoke` | `Authorization: Bearer <machine token>`: the computer revokes itself (`uncage sites remove`) |
| `GET /agent` (WebSocket upgrade) | The agent connection (`Authorization: Bearer <machine token>`), registered by `hub.attach(server)`. Protocol version 1; frames are JSON, at most 1 MiB each |

## Errors

Every error is JSON with the HTTP status of its code:

```json
{ "code": "machine_offline", "message": "The machine is offline.", "hint": "Make sure the Uncage agent is running on that machine and connected to the internet.", "retryable": true, "requestId": "req_…" }
```

`details` is added where useful (for example `details.reason`, `details.retryAfterSec`). The full list is in [Error codes](/uncage/reference/errors/).
