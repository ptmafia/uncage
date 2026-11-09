# @uncage/react-ui

## 0.4.0

### Minor Changes

- Uncage 0.4: React Native apps and browser extensions become entry points, and one installed agent serves every Uncage site. `@uncage/client` and `@uncage/react` run in React Native (async headers, native file uploads, `reconnect()`, device approval, storage-adapter session persistence); the hub adds `trustedOrigins`, HTTP device approval routes, `onAttention` with `expoPushNotifier`, and `installInfo.connectUrl`; the CLI adds one-click connect (`uncage://` handler, `uncage connect` with a native confirmation and site identity checks), `uncage dashboard`, and a QR code in `uncage setup`. Breaking for custom implementations: `UncageClient` requires `reconnect`, `lookupDevice` and `decideDevice`; `UncageStore` requires `client`; `PersistSessionMode` accepts a storage adapter and restores asynchronously.

### Patch Changes

- Updated dependencies
  - @uncage/protocol@0.4.0
  - @uncage/react@0.4.0

## 0.3.1

### Patch Changes

- @uncage/protocol@0.3.1
  - @uncage/react@0.3.1

## 0.3.0

### Minor Changes

- Uncage 0.3: the hub runs anywhere (traditional mode on a Node server, FaaS mode on Vercel, Cloudflare Workers and other Fetch platforms with only Postgres), computers connect over WebSocket or HTTPS streaming (connected protocol 2), any Agent Client Protocol agent can be offered (new `@uncage/runtime-acp`, auto-detected from the ACP registry with consent), and the one-command installer supports macOS, Linux and Windows. Breaking: `@uncage/hub` root is Web-standard (`toNodeHandler`, `attachWebSocket`, `pgliteHubStore` move to `@uncage/hub/node`), `createHub` requires `store`, `hub.handler` → `hub.fetch`, `hub.attach` → `attachWebSocket`, agents must be 0.3 or newer. See https://uncage-dev.vercel.app/docs/reference/migrate-from-0-2/

### Patch Changes

- Updated dependencies
  - @uncage/protocol@0.3.0
  - @uncage/react@0.3.0

## 0.2.0

- `<AgentChat>` restores the last active session on reload.
- New `<ConnectMachine>`, `<ApproveDevice>` and `<MachineStatus>`; `<AgentChat>` shows the computer picker, the connect flow when no computer is connected, and a disabled composer while the computer is offline.
- `<ApproveDevice>` shows a failed code lookup's localized error (e.g. rate limited) instead of "invalid or expired".
