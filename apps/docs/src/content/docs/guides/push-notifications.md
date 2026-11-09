---
title: "Push notifications"
description: "Notify users when their computer needs them: the hub's onAttention hook (approval requested, run completed or failed), at-most-once delivery with stale-event suppression, the ready expoPushNotifier for Expo Push, registering device tokens, and how to test."
---

When an approval is waiting or a run ends, a user with the app in their pocket should find out. The hub calls your `onAttention` hook for that; you send the push through your own provider. For Expo Push there is a ready handler.

## `onAttention`

```ts title="attention.ts"
import type { AttentionEvent, OnAttention } from '@uncage/hub';

export const onAttention: OnAttention = async (e: AttentionEvent, { waitUntil }) => {
  // e.kind: 'approval_requested' | 'run_completed' | 'run_failed'
  // e.userId, e.sessionId, e.sessionTitle?, e.machineId, e.machineName?, e.runtime?,
  // e.approval?: { id, title, category }, e.at (when it happened on the computer)
  waitUntil(sendPush(e.userId, `${e.kind}: ${e.sessionTitle ?? e.sessionId}`));
};

declare function sendPush(userId: string, text: string): Promise<void>;
```

Pass it as `createHub({ …, onAttention })`. How it behaves:

- **Once per event.** It fires after the hub accepted the event, in both `sessionStorage` modes, once per `sessionId:sequence:kind`: an agent that resends, or several hub nodes that all see the event, notify once. The dedupe uses the optional store method `claimOnce(key, { ttlSec, now })` (implemented by the SQL, Postgres and PGlite stores, claims kept for a day). A custom store without `claimOnce` gets per-node in-memory dedupe, best effort.
- **Delivery is at most once.** If your handler throws or rejects, the error goes to `logger.error` and the event is **not** retried.
- **Never blocks ingest.** Errors never fail the event. On FaaS platforms the call runs under the request’s `waitUntil`; `ctx.waitUntil` hands more work to the same context.
- **Stale events are skipped.** An event whose time is older than **10 minutes** (an agent backfilling after a reconnect) never notifies. In `'site'` mode an approval that the stored snapshot already shows answered is skipped too.
- **Clock note.** “Older” compares the event’s time from the computer’s clock with the hub’s clock. Keep both within a few minutes (NTP). A computer whose clock is more than 10 minutes behind never notifies; the hub logs a warning about it, at most once an hour per machine.

## What leaves your hub

A push goes from your hub to Expo, then to Apple or Google, and shows on the lock screen. The default text is built from the event and the **approval title**, and runtimes set that title from the tool call, so it can name a command or a file path. The default is one line of at most 180 characters (it includes the approval title and the session title), but it still reaches those services and the lock screen. If that is too much for your users, return a generic text from `message`:

```ts
import { expoPushNotifier } from '@uncage/hub';

declare const tokensFor: (userId: string) => Promise<string[]>;

expoPushNotifier({
  tokensFor,
  message: (e) => ({ title: 'Uncage', body: e.approval ? 'An action needs your approval' : 'Your run has finished' }),
});
```

## `expoPushNotifier`

```ts title="hub.ts"
import { expoPushNotifier } from '@uncage/hub';

declare const tokenDb: {
  list(userId: string): Promise<string[]>;
  remove(token: string): Promise<void>;
};

export const onAttention = expoPushNotifier({
  // The user's Expo push tokens, from YOUR database: the hub never stores them.
  tokensFor: (userId) => tokenDb.list(userId),
  // Expo reported DeviceNotRegistered (app uninstalled): delete the token.
  onInvalidToken: (token) => tokenDb.remove(token),
});
```

It uses only `fetch`, so it runs anywhere the hub does (it is exported from the Web-standard root). It sends one message per token, in requests of at most 100, with `data: { sessionId, approvalId?, kind }` so the app can open the right chat.

| Option | |
| --- | --- |
| `tokensFor(userId)` | Required. The user’s Expo push tokens. |
| `accessToken` | Expo access token when enhanced push security is on. |
| `message(e)` | `{ title, body }` per event, or `null` to send nothing. The default is short English text (`defaultPushMessage`); localize here. |
| `onInvalidToken(token)` | Called for tokens Expo reports as `DeviceNotRegistered`. |
| `fetch`, `endpoint` | Replace `fetch` or the Expo endpoint (tests). |
| `timeoutMs` | A request to Expo unanswered after this is aborted and the call rejects (the hub logs it). Default `15000`. |

It rejects (and the hub logs, with error codes and counts but never tokens) when a request fails or times out, when `onInvalidToken` throws, or when Expo refused messages for another reason, for example `InvalidCredentials`. When several sends fail, it rejects with an `AggregateError` that holds all of them.

## Registering tokens

The app asks permission, gets its token with `expo-notifications` (`getExpoPushTokenAsync({ projectId })`) and sends it to **your** backend, which stores it per user. `examples/connected-demo` has `POST /api/app/push-token` `{ token }` (and `DELETE` on sign-out), validates the token shape and keeps at most 10 per user (oldest dropped). It also drops tokens not re-registered for 30 days. A token belongs to one user at a time: the latest sign-in on the device wins, so a shared device does not leak notifications to the previous user. Treat tokens as semi-secret. In the demo, set `EXPO_PUSH=1` (and optionally `EXPO_ACCESS_TOKEN`) to switch the hub’s `onAttention` on.

## What works where

- Remote push needs a **development build**: Expo Go has none on Android since SDK 53.
- **Android:** a free Expo account with EAS builds an Android development build; a free Firebase project supplies FCM credentials. Built and unit-tested against a fake Expo endpoint; **awaiting device confirmation**.
- **iOS:** needs a paid Apple Developer account (APNs). Implemented and configurable; **not verified on a device**.

## Testing

Unit-test the handler with a fake `fetch` (the option exists for that) and a hub whose agent emits `approval.requested`: expect one call, none for the same sequence again, none for events older than ten minutes. The hub’s own tests do exactly this.

See also [mount the hub](/docs/guides/mount-the-hub/#createhub-options) and [React Native apps](/docs/guides/react-native/).
