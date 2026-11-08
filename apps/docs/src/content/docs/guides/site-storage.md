---
title: Site storage
description: Keep a replica of every conversation on your website with sessionStorage 'site', so history stays readable while the user's computer is off, and read the replica and the tool-call audit from your own code.
---

Sessions run on the user’s computer, and that computer’s local database is the source of truth. The question is whether **your website** also keeps a copy.

| `sessionStorage` | History while the computer is offline | Where the hub reads history |
| --- | --- | --- |
| `'machine'` (default) | Not visible: the session list is empty and opening a session fails with `machine_offline` | Asks the computer each time |
| `'site'` | Fully visible, read-only | Its own store (the replica) |

Choose `'site'` when the process should stay visible on your website: reviewing what the agent did, sharing results, support. The reference demo uses it. Choose `'machine'` when conversations must not leave the user’s computer except while they are being viewed.

```ts title="hub.ts"
import { createHub, pgliteHubStore, type HubUser } from '@uncage/hub';

declare function getUser(req: Request): Promise<HubUser | null>;

export const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
export const hub = await createHub({
  publicUrl: 'https://app.example.com',
  getUser,
  store,
  sessionStorage: 'site',
});
```

## How the replica works

- The hub replicates only sessions it created itself (`POST <basePath>/sessions` picks the session id and records it before the computer creates the session). Events a computer sends for any other session id are ignored and logged (`events for a session the hub did not create ignored`). With `'machine'` storage such sessions are still indexed so they can be listed.

- Every event of a session has a sequence number (1, 2, 3, …). The computer writes it to its own database first, then sends it to the hub.
- The hub appends only the **next** sequence it is missing, so the replica is always a gap-free prefix of the session, and acknowledges how far it got.
- When the computer reconnects, the hub tells it the last sequence it has for each of its sessions, and the computer resends from there. Nothing is lost while it was offline and nothing is stored twice.
- Only the computer writes events, so there are no conflicts. Approvals are still decided on the computer: the hub forwards the decision, and the result comes back as an event.
- Very large single events (a huge command output, for example) are shortened by the agent with a `[truncated N bytes]` marker so they fit in one frame. The replica stays gap-free.
- The hub also keeps a **snapshot** per session (session, runs, pending approvals, last sequence), rebuilt from the events, so opening a session does not replay the whole history.

With the computer offline, `<AgentChat>` shows the history and disables the composer: “Your computer is offline. Waiting for it to reconnect…”. When it reconnects, the missing events arrive and the session is live again.

## Reading the replica yourself

Keep a reference to the store you pass to `createHub`, and read from it in your own pages, admin tools or exports. Always filter by the signed-in user.

```ts title="history.ts"
import type { HubStore, ToolCallRecord } from '@uncage/hub';
import type { UncageEvent } from '@uncage/protocol';

/** A user's conversations, newest first, with their titles. */
export async function listConversations(store: HubStore, userId: string) {
  const sessions = await store.listSessions(userId); // oldest first
  return sessions.reverse().map((s) => ({ id: s.id, title: s.title, machineId: s.machineId, createdAt: s.createdAt }));
}

/** Every replicated event of one of the user's sessions, in order. */
export async function readConversation(store: HubStore, userId: string, sessionId: string): Promise<UncageEvent[]> {
  const session = await store.getSession(sessionId);
  if (!session || session.userId !== userId) throw new Error('not found');
  const events: UncageEvent[] = [];
  for (let after = 0; ; ) {
    const page = await store.readEvents(sessionId, after, 500);
    if (page.length === 0) return events;
    events.push(...page);
    after = page[page.length - 1]!.sequence;
  }
}

/** What your tools did in a session: one row per call, with status and timing. */
export function toolCalls(store: HubStore, sessionId: string): Promise<ToolCallRecord[]> {
  return store.listToolCalls(sessionId);
}
```

`SessionRecord.snapshot` holds the latest snapshot when `sessionStorage` is `'site'`. The [generated reference](/docs/api/hub/) lists every `HubStore` method. Treat the store as read-only from your code; the hub owns its tables.

## The tool-call audit (both modes)

Whatever `sessionStorage` is, the hub records every site tool call: who (`userId`, `machineId`), which session and run, the tool, its arguments (unless larger than 16 KB), the status (`running`, `ok`, `error`, `invalid`, `timeout`, `cancelled`), the error code and message, and the timing. Read it with `store.listToolCalls(sessionId)`.

## Retention and size

The hub does not delete replicated events. Plan for the space: a typical run is tens to hundreds of events, mostly small text deltas. If you need retention, delete old sessions’ rows in your database on your own schedule (the tables are created by `migrateHubStore`; see `HUB_MIGRATIONS` in `@uncage/hub` for the schema).

## Attachments

Attachments uploaded in the browser are sent to the computer, which keeps its own copy in the session workspace. **In both modes, including `'machine'`, the hub also keeps a copy** in its store (`uncage_hub_attachments`), so the image or file still shows in the chat history. That copy is deleted:

- after `attachmentRetentionDays` (default 30, checked by an hourly sweep on every node); after that `GET <basePath>/attachments/:id` answers 404;
- at once, when the computer is revoked (from the website, `hub.revokeMachine`, or `uncage sites remove` on the computer).

Pass `attachmentRetentionDays: Infinity` to keep them until the computer is revoked, or a smaller number if attachments must not stay on your servers.

## Switching modes

`sessionStorage` can be changed at any time. Switching to `'site'` replicates every session of a computer when it next connects, from its first event. Switching back to `'machine'` leaves existing replica rows in the store, unused.
