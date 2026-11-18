# @uncage/runtime-codex

## 0.4.1

### Patch Changes

- 2297f9b: Security fixes.
  
  **Behaviour change, check before upgrading:** `<ApproveDevice>` and `useDeviceApproval` now treat every code as coming from a link unless you pass `source: 'typed'`. For such a code, Approve stays disabled (and `approve()` does nothing, with one `console.warn`) until the user typed the code's last 4 characters. If you render your own approve screen with `useDeviceApproval`, show the warning, the request time and IP, and an input wired to `confirmation.setTyped`, or Approve will never work. Pass `source: 'typed'` only for a code the user typed on your page, never based on the URL.
  
  - **Device-approval phishing (high).** Anyone could run `uncage setup` against a site on their own computer and send a user the `/device?code=` link; approving it linked the sender's computer to the user's account. The hub now stores the requesting client IP (store migration 10; `null` when the hub has no trusted client IP) and `lookupDevice` / `GET /device/lookup` return `requestedAt` and `requestIp`. The approve UI warns, shows the request time and the IP as seen by the server, labels the name and OS as reported by the computer, hides the code's last 4 characters (masked from the compacted code) and enables Approve only after the user typed them. A link code that is not exactly `ABCD-EFGH` / `ABCDEFGH` is refused as "not a valid link" without a lookup. The hub drops a reported computer name or OS that contains the code's last 4 characters and strips control characters from both. Deny stays one click.
  - **Push notifications leaked conversation content (medium).** `expoPushNotifier` / `defaultPushMessage` now send generic text ("An approval needs you", "A run finished", "A run failed") plus the deep-link data. Session and approval titles (often shell commands or paths) are included only with `includeContent: true`.
- Updated dependencies [2297f9b]
  - @uncage/protocol@0.4.1

## 0.4.0

### Minor Changes

- Uncage 0.4: React Native apps and browser extensions become entry points, and one installed agent serves every Uncage site. `@uncage/client` and `@uncage/react` run in React Native (async headers, native file uploads, `reconnect()`, device approval, storage-adapter session persistence); the hub adds `trustedOrigins`, HTTP device approval routes, `onAttention` with `expoPushNotifier`, and `installInfo.connectUrl`; the CLI adds one-click connect (`uncage://` handler, `uncage connect` with a native confirmation and site identity checks), `uncage dashboard`, and a QR code in `uncage setup`. Breaking for custom implementations: `UncageClient` requires `reconnect`, `lookupDevice` and `decideDevice`; `UncageStore` requires `client`; `PersistSessionMode` accepts a storage adapter and restores asynchronously.

### Patch Changes

- Updated dependencies
  - @uncage/protocol@0.4.0

## 0.3.1

### Patch Changes

- @uncage/protocol@0.3.1

## 0.3.0

### Minor Changes

- Uncage 0.3: the hub runs anywhere (traditional mode on a Node server, FaaS mode on Vercel, Cloudflare Workers and other Fetch platforms with only Postgres), computers connect over WebSocket or HTTPS streaming (connected protocol 2), any Agent Client Protocol agent can be offered (new `@uncage/runtime-acp`, auto-detected from the ACP registry with consent), and the one-command installer supports macOS, Linux and Windows. Breaking: `@uncage/hub` root is Web-standard (`toNodeHandler`, `attachWebSocket`, `pgliteHubStore` move to `@uncage/hub/node`), `createHub` requires `store`, `hub.handler` → `hub.fetch`, `hub.attach` → `attachWebSocket`, agents must be 0.3 or newer. See https://uncage-dev.vercel.app/docs/reference/migrate-from-0-2/

### Patch Changes

- Updated dependencies
  - @uncage/protocol@0.3.0

## 0.2.0

- Version bump with the fixed release group; no functional changes.
