---
title: "React Native apps"
description: "Use @uncage/client and @uncage/react in an Expo / React Native app: streaming with expo/fetch, bearer-token headers, a storage adapter for the open session, photo uploads, resuming after the app was in the background, and approving a new computer from a phone."
---

A native app is one more entry point to the same hub. It talks only to **your backend** (the hub), signs in with a bearer token you issue, and drives the user’s own computer exactly like your website does. The app never holds a machine token and never talks to the computer directly.

`@uncage/client` and `@uncage/react` (the headless hooks) run in React Native without changes. They import nothing from `react-native` or `expo-*`; everything platform-specific is an adapter your app passes in. There is no React Native UI kit: [`examples/connected-expo`](https://github.com/ptmafia/uncage/tree/main/examples/connected-expo) shows how to build the screens with the hooks, to copy rather than install.

:::note[Status]
Built and unit-tested in a simulated React Native environment (no `window.location`, no `localStorage`, no `EventSource`, a streaming `fetch`, async headers). Verified on a real device: not yet, awaiting device confirmation. Expo Go covers chat, computers, approvals and photos; push and app links need a development build ([push notifications](/docs/guides/push-notifications/)).
:::

## 1. Hub side

Your hub needs two things for apps: a `getUser` that accepts your app’s token ([authenticate apps](/docs/guides/authenticate-apps/)), and, optionally, push ([push notifications](/docs/guides/push-notifications/)). Native requests carry no `Origin` header, so the hub’s cross-site guard lets them through; a browser page from another site is still refused.

## 2. The client

Install the packages and create the client with a streaming `fetch` and your token:

```ts nocheck
import { createUncageClient } from '@uncage/client';
import { fetch as streamFetch } from 'expo/fetch';

export const client = createUncageClient({
  baseUrl: 'https://your.site/api/uncage',
  fetch: streamFetch,
  // Called for every request and every stream (re)connect; may be async (token refresh).
  headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
});
```

- **Streaming.** React Native’s built-in `fetch` cannot stream a response body, and the client reads events from `response.body.getReader()`. Expo’s `expo/fetch` streams. In bare React Native use any `fetch` polyfill that exposes `body.getReader()`. Where `TextDecoder` is missing (older Hermes) the client uses a small built-in UTF-8 decoder.
- **Uploads.** `uploadAttachment` accepts a browser `File` or an `{ uri, name, type }` object from `expo-image-picker`. For the second form the client reads the file with the global `fetch(uri)` then sends it through your `fetch`. In Expo SDK 58 and later the global `fetch` is `expo/fetch` (React Native’s own `fetch` only with `EXPO_PUBLIC_USE_RN_FETCH=1`). It reads `file://` URIs but **not** `content://`: `expo-image-picker` already hands over `file://` copies, and any `content://` URI must be copied to a cache file first. `examples/connected-expo` keeps event streams on `expo/fetch` and sends other requests through the global one. `useAttachments().add()` accepts the same `{ uri, name, type, size? }` file references (the `AttachmentFile` type) as well as named `Blob`s.
- **Images.** `client.attachmentUrl(id)` needs the auth header, so render with `<Image source={{ uri, headers }} />`.
- **Async headers.** If `headers()` throws (a failed token refresh) requests fail with `unauthorized` and `details.reason: 'headers'`; the stream reports it through `onError` and retries.

## 3. Hooks

Wrap the app in `UncageProvider` and use the hooks as on the web (`useMachines`, `useSession`, `useRuns`, `useApprovals`, … ). Three things are specific to apps:

```tsx nocheck
import { usePersistSession, useReconnect, type PersistSessionStorage } from '@uncage/react';
import * as SecureStore from 'expo-secure-store';
import { useEffect } from 'react';
import { AppState } from 'react-native';

const storage: PersistSessionStorage = {
  get: () => SecureStore.getItemAsync('uncage.session'),
  set: (id) => (id === undefined ? SecureStore.deleteItemAsync('uncage.session') : SecureStore.setItemAsync('uncage.session', id)),
};

export function useAppLifecycle() {
  usePersistSession(storage); // reopen the last conversation after a restart
  const reconnect = useReconnect();
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && reconnect());
    return () => sub.remove();
  }, [reconnect]);
}
```

- **`usePersistSession(storage)`** takes an adapter `{ get, set }` (sync or async: AsyncStorage, SecureStore, MMKV). With the default `'url'` or with `'localStorage'` and no `window` / `localStorage` it does nothing and never throws.
- **`useReconnect()`** returns `client.reconnect()`: it restarts every open event stream at once from its last sequence, so after the app was in the background for minutes nothing is lost and nothing repeats. Call it when `AppState` becomes `active`. A stream that is healthy (bytes arrived in the last 20 seconds) is kept; `reconnect({ force: true })` restarts it anyway.
- **`useDeviceApproval(code)`** drives the approve screen below.

## 4. Approving a computer from the phone

`uncage setup` prints the approval link as a terminal QR code (`--no-qr` turns it off; it is skipped when the output is not a terminal). If you map the hub’s verification path (`/device` by default) to your app with Android App Links or iOS universal links, scanning the code opens your approval screen; otherwise the phone opens your mobile web approval page.

```tsx nocheck
import { useDeviceApproval } from '@uncage/react';

export function ApproveScreen({ code }: { code: string }) {
  const { lookup, state, error, approve, deny } = useDeviceApproval(code);
  // state: 'loading' | 'idle' | 'approving' | 'denying' | 'approved' | 'denied'
  //        | 'not_found' | 'expired' | 'error'
  // lookup: { name?, os?, expiresAt, repairsMachine } | null: show it so the user compares the computer.
  // error: { code, message }, e.g. 'rate_limited' (10 wrong codes in 10 minutes).
  return null; // render lookup, error and two buttons that call approve() / deny()
}
```

`state` is `'error'` when the lookup itself failed (for example `rate_limited`); call `retry()` to run the lookup again; a failed decision returns to `'idle'` with `error` set so the user can retry. `approve()` and `deny()` act only from `'idle'`. Under the hood these call [`GET /device/lookup` and `POST /device/decision`](/docs/reference/http-api/#device-approval-for-apps); `client.lookupDevice(code)` and `client.decideDevice(code, approve)` are the same without React.

- **Android App Links:** serve `/.well-known/assetlinks.json` (package name and signing-certificate fingerprint) from your site. `examples/connected-demo` builds it from `ANDROID_PACKAGE` and `ANDROID_SHA256`. Built and unit-tested; awaiting device confirmation.
- **iOS universal links:** serve `/.well-known/apple-app-site-association` (Team ID and bundle id: `APPLE_TEAM_ID`, `IOS_BUNDLE_ID` in the demo). Needs a paid Apple Developer account; implemented and configurable, **not verified on a device**. On iOS the QR code falls back to the mobile web approval page.

## Without a paid account

Everything except iOS links and iOS push works with free tools: Expo Go for chat, computers, approvals, pickers and photos; a free Expo account with EAS for an Android development build (push, App Links); a free Firebase project for Android push. The example’s README has the steps.

## Next

[Authenticate apps](/docs/guides/authenticate-apps/) · [Push notifications](/docs/guides/push-notifications/) · [Custom UI](/docs/guides/custom-ui/) · [HTTP API](/docs/reference/http-api/)
