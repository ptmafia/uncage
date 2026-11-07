# @uncage/client

Browser transport for Uncage without React: typed REST calls and a resumable SSE event stream, about 5 KB minified with no runtime dependencies. Most apps use it through [`@uncage/react`](https://www.npmjs.com/package/@uncage/react); use it directly for Vue, Svelte, vanilla JS or scripts.

```sh
npm i @uncage/client
```

It talks to your app's same-origin proxy (`createUncageHandler` / `createUncageNodeHandler` from `@uncage/server/proxy`), never to the daemon directly: the proxy adds the daemon token on the server.

## API

`createUncageClient({ baseUrl = '/api/uncage', fetch?, headers? })` returns:

| Method | HTTP (under `baseUrl`) | Returns |
| --- | --- | --- |
| `health()` | `GET /health` | `{ ok, protocol, version }` |
| `runtimes()` | `GET /runtimes` | `RuntimeInfo[]` (`status`: `available` / `not_installed` / `auth_required` / …, with `hint`) |
| `createSession({ runtime, workspace?, title? })` | `POST /sessions` | `Session` |
| `listSessions()` | `GET /sessions` | `Session[]` (oldest first) |
| `snapshot(sessionId)` | `GET /sessions/:id` | `{ session, runs, pendingApprovals, lastSequence }` |
| `startRun(sessionId, { prompt, attachmentIds? })` | `POST /sessions/:id/runs` | `Run` (queued; progress arrives as events) |
| `cancelRun(runId)` | `POST /runs/:id/cancel` | `Run` |
| `decide(approvalId, { decision: 'allow' \| 'deny', scope: 'once' \| 'session' }, key?)` | `POST /approvals/:id/decision` | `ApprovalRequest` |
| `updateSettings(sessionId, { model?, effort?, permissionMode? })` | `PATCH /sessions/:id/settings` | `Session` (applies from the next run) |
| `uploadAttachment(sessionId, file, { signal? })` | `POST /sessions/:id/attachments` | `Attachment` (send its `id` in `attachmentIds`) |
| `attachmentUrl(attachmentId)` | `GET /attachments/:id` | a URL for `<img src>` |
| `listActiveRuns()` | `GET /runs?active=1` | `ActiveRunInfo[]` across sessions |
| `subscribe(sessionId, { after, onEvent, onState?, onError? })` | `GET /sessions/:id/events` (SSE) | an unsubscribe function |

`startRun` and `decide` send an `Idempotency-Key` header (a fresh UUID; pass your own `key` to `decide` to make retries safe). Calling the HTTP API yourself, these two endpoints **require** `Idempotency-Key`: without it you get 400 `invalid_request`. Repeating a key with the same body returns the first result instead of starting a second run.

Failures throw `UncageClientError` with `code` (`session_busy`, `forbidden_origin`, `runtime_unavailable`, …), a human `message` and `hint`, the HTTP `status` (0 for network errors) and `details.reason` (`network`, `http_status`, `daemon_unreachable`).

## Events

`subscribe` replays events after `after` (use `0` for the full history, or a snapshot's `lastSequence`), then streams live ones. It reconnects with backoff and `Last-Event-ID`, skips duplicates, and reports `onState('connecting' | 'live' | 'reconnecting' | 'offline')`. If the server no longer has the older events, `onError` gets `event_replay_unavailable`: take a new `snapshot()` and subscribe from its `lastSequence`.

Every event has `{ eventId, sequence, sessionId, runId?, type, occurredAt, payload }`:

| `type` | `payload` |
| --- | --- |
| `session.created`, `session.updated` | `{ session }` (the first run sets `session.title` from the prompt) |
| `run.started` | `{ run }` |
| `run.updated` | `{ runId, state }` |
| `run.completed` / `run.failed` / `run.cancelled` / `run.interrupted` | `{ runId, durationMs }` / `{ runId, error }` / `{ runId }` / `{ runId, reason }` |
| `message.started` / `message.delta` / `message.completed` | `{ messageId, role }` / `{ messageId, chunkIndex, text }` / `{ messageId, text }` |
| `tool.started` | `{ toolId, name, title, category, input? }` |
| `tool.updated` / `tool.completed` / `tool.failed` | `{ toolId, output? }` / `{ toolId, output?, durationMs? }` / `{ toolId, error, declined? }` |
| `approval.requested` / `approval.updated` / `approval.resolved` | `{ approval }` (`approval.state`: `pending` → `approved` / `denied` / `expired` / `cancelled`) |
| `system.warning` | `{ code, message }` |

Events are checked structurally in the browser: the envelope, plus the id each known type is keyed on (`session.id`, `run.id` / `runId`, `approval.id`, `messageId`, `toolId`). Malformed frames are dropped with one console warning. Event types newer than this client pass through, so switch on `type` and ignore the rest. All of these types (`UncageEvent`, `UncageEventMap`, `ApprovalRequest`, `RuntimeInfo`, `Session`, `Run`, …) are exported from `@uncage/client`, so you don't need `@uncage/protocol`.

## A vanilla chat

```ts
import { createUncageClient, type UncageEvent } from '@uncage/client';

const client = createUncageClient();
const log = document.querySelector('#log')!;
const runtime = (await client.runtimes()).find((r) => r.status === 'available');
if (!runtime) throw new Error('No runtime available: run `npx uncage doctor`');
const session = await client.createSession({ runtime: runtime.id });

const line = (text: string) => log.appendChild(document.createElement('p')).append(text);
client.subscribe(session.id, {
  after: 0,
  onState: (s) => document.body.setAttribute('data-connection', s),
  onEvent(e: UncageEvent) {
    if (e.type === 'message.completed') line(e.payload.text);
    if (e.type === 'tool.started') line(`▸ ${e.payload.title}`);
    if (e.type === 'run.failed') line(`✗ ${e.payload.error.message}`);
    if (e.type === 'approval.requested') {
      const a = e.payload.approval;
      const ok = confirm(`Allow: ${a.title}\n${a.target.command ?? ''}`);
      void client.decide(a.id, { decision: ok ? 'allow' : 'deny', scope: 'once' });
    }
  },
});

document.querySelector('form')!.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = document.querySelector('input')!;
  line(`> ${input.value}`);
  void client.startRun(session.id, { prompt: input.value });
  input.value = '';
});
```

Stream text as it arrives by appending `message.delta` text per `messageId` instead of waiting for `message.completed`. Stop a run with `client.cancelRun(run.id)`.

---

Part of **Uncage** — bring Claude Code (and Codex) into your own app with approvals, streaming and a ready-made UI. Start with [`@uncage/react-ui`](https://www.npmjs.com/package/@uncage/react-ui) for the 5-minute setup. MIT licensed.
