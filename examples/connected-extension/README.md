# connected-extension

A Chrome (Manifest V3) **side panel** that drives the user's own local agent through a website's
Uncage hub. The panel is `@uncage/react-ui`'s `<AgentChat>` talking to the hub's browser API:

```tsx
const client = createUncageClient({
  baseUrl: `${HUB_ORIGIN}/api/uncage`,
  fetch: (url, init) => fetch(url, { ...init, credentials: 'include' }),
});
<UncageProvider client={client}><AgentChat /></UncageProvider>
```

There is no sign-in UI in the extension. It uses the **cookies of the site**: the manifest's host
permission for the hub's origin plus `credentials: 'include'` send them, so the hub's `getUser`
sees the user already signed in on the site. The extension's own origin (`chrome-extension://<id>`)
is a cross-site origin to the hub, so the hub must list it in `trustedOrigins`.

## Build and load

```sh
pnpm install
HUB_ORIGIN=http://localhost:3200 pnpm --filter connected-extension build   # default HUB_ORIGIN is http://localhost:3200
```

`HUB_ORIGIN` is the site's origin (no path); it becomes the manifest's only `host_permissions`
entry and the panel's `baseUrl`. Then open `chrome://extensions`, turn on Developer mode, **Load
unpacked** and pick `examples/connected-extension/dist`. Click the toolbar icon to open the panel.

## Trust the extension on the hub

The extension's id is stable during development because `manifest.json` carries a fixed public
`key` (a throwaway RSA key generated for this example; its private key was discarded):

```
chrome-extension://bocaoaanfikfdhmnhipmjpkcepaioapj
```

Start the hub with that origin (`dev` is the development mode; `start` is production mode and needs `pnpm build` first; the `connected-demo` reads `TRUSTED_ORIGINS`, comma separated):

```sh
TRUSTED_ORIGINS=chrome-extension://bocaoaanfikfdhmnhipmjpkcepaioapj pnpm --filter connected-demo dev
```

or, in your own hub: `createHub({ ..., trustedOrigins: ['chrome-extension://bocaoaanfikfdhmnhipmjpkcepaioapj'] })`.
Sign in on the site in the same Chrome profile, connect a computer (`uncage setup <site url>`), and
the panel lists it.

**For your own extension:** remove the `key` from `manifest.json` (or generate your own). Chrome
Web Store extensions get their id from the store; put that id in `trustedOrigins`. Only exact
origins are accepted (no wildcards), so list every id you ship (store build, dev build).

## Cookies and SameSite

Chrome sends the site's cookies to extension pages that hold the host permission, including
`SameSite=Lax` ones, so the demo's sign-in cookie works as is. If your site's session cookie is
`SameSite=Strict` or the user has blocked third-party cookies for the site, the panel will show the
signed-out state; use a bearer token instead (`createUncageClient({ headers })`).

## Test

`e2e` project `extension-mock` (`pnpm --dir e2e exec playwright test --project=extension-mock`)
builds this extension for the mock connected stack, loads it unpacked, signs in on the demo,
connects the fake agent, then opens `chrome-extension://<id>/panel.html` in a tab and checks that
the panel lists the computer and runs a session. Branded Chrome 137+ ignores `--load-extension`, so
the spec uses `UNCAGE_EXTENSION_CHROME=<Chromium or Chrome for Testing binary>`, else Playwright's
bundled Chromium (installed in CI), and skips with the reason when the extension does not load. It
runs headless; no display is needed.
