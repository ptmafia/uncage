---
title: "Browser extensions"
description: "Put the agent in a Chrome Manifest V3 side panel: AgentChat against your hub with the site's cookies, trustedOrigins for chrome-extension://<id> (exact origins only), stable extension ids, cookie and SameSite caveats, and bearer tokens as the alternative."
---

A browser extension is a client like any other: the side panel renders `<AgentChat>` from `@uncage/react-ui` against your hub. [`examples/connected-extension`](https://github.com/ptmafia/uncage/tree/main/examples/connected-extension) is a complete Chrome (Manifest V3) side panel built with Vite.

:::note[Status]
Built and tested: the repository’s `extension-mock` end-to-end project loads the unpacked extension in Chromium, signs in on the demo, connects a fake agent and runs a session from the panel. Using it by hand in your own Chrome profile: awaiting confirmation.
:::

## The panel

```tsx nocheck
import { createUncageClient } from '@uncage/client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';

const client = createUncageClient({
  baseUrl: `${HUB_ORIGIN}/api/uncage`,
  fetch: (url, init) => fetch(url, { ...init, credentials: 'include' }),
});

export const Panel = () => (
  <UncageProvider client={client}>
    <AgentChat />
  </UncageProvider>
);
```

There is no sign-in screen in the extension. The manifest’s host permission for your site’s origin plus `credentials: 'include'` send the user’s **cookies for your site**, so `getUser` sees the user who is already signed in there. If you would rather not depend on cookies, send a bearer token instead (`createUncageClient({ headers })`, see [authenticate apps](/docs/guides/authenticate-apps/)).

## Tell the hub to trust the extension

The extension’s origin, `chrome-extension://<id>`, is a different origin from your site, so the hub’s cross-site guard refuses its state-changing requests. List it:

```ts title="hub.ts"
import { createHub, type HubOptions } from '@uncage/hub';

declare const base: Omit<HubOptions, 'trustedOrigins'>;

export const hub = createHub({
  ...base,
  trustedOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
});
```

`trustedOrigins` rules (`createHub` throws on a bad entry):

- Exact origins only: `scheme://host[:port]`, lower case, no wildcard, path, query, credentials or trailing slash. List every id you ship (store build, development build).
- Allowed schemes: `https`, `chrome-extension`, `moz-extension`, `safari-web-extension`, and `http` only for `localhost`, `127.0.0.1` and `[::1]`. `file:`, `data:`, `javascript:`, `blob:` and others are refused.
- **Only origins you control.** A trusted origin is allowed to make state-changing requests with the user’s cookies. Any script that runs in that extension acts as the user, so ship it like a first-party app.
- This does not weaken the guard for websites: every other foreign `Origin` is still refused.
- It does not add CORS. The hub sends no CORS headers and does not answer preflight, so it is meant for extensions (whose host permission bypasses CORS) and native shells. A web page on a trusted `https` origin can call the hub from a browser only if your framework adds CORS.

In `examples/connected-demo`, set `TRUSTED_ORIGINS=chrome-extension://<id>` (comma-separated).

## Extension ids

An unpacked extension’s id depends on its path unless `manifest.json` carries a fixed public `key`. The example ships a throwaway key so its id is stable (`chrome-extension://bocaoaanfikfdhmnhipmjpkcepaioapj`) in development; remove it for your own extension. Chrome Web Store builds get their id from the store: put that one in `trustedOrigins`.

## Build and load

```sh
HUB_ORIGIN=https://your.site pnpm --filter connected-extension build
```

`HUB_ORIGIN` (the site’s origin, no path) becomes the manifest’s only `host_permissions` entry and the panel’s `baseUrl`. For a local hub, run the demo in development mode, `TRUSTED_ORIGINS=chrome-extension://<id> pnpm --filter connected-demo dev` (the `start` script is production mode and needs `pnpm build` first). Open `chrome://extensions`, turn on Developer mode, **Load unpacked** and pick the `dist` folder; click the toolbar icon to open the side panel. Sign in on the site in the same Chrome profile and connect a computer ([one-click connect](/docs/guides/one-click-connect/) or `uncage setup`).

## Cookies and SameSite

Chrome sends a site’s cookies to extension pages that hold the host permission, including `SameSite=Lax` ones. If your session cookie is `SameSite=Strict`, or the user blocks third-party cookies for your site, the panel shows the signed-out state: use a bearer token.

See also [mount the hub](/docs/guides/mount-the-hub/#createhub-options) and the [security page](/docs/reference/security/).
