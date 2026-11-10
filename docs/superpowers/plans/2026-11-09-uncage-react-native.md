# Uncage for React Native apps, browser extensions, and one agent for every site — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer's React Native app and browser extension become first-class Uncage entry points (SDK, push, scan-to-connect), and a user's installed agent connects to any further Uncage site in one click with site identity checks and a local dashboard.

**Architecture:** Apps and extensions are just more clients of the hub's browser API (bearer auth through the developer's `getUser`); the agent side is unchanged except for an OS URL handler, `uncage connect` and `uncage dashboard`. The hub gains `trustedOrigins`, device-approval routes, `onAttention` (+ `expoPushNotifier`) and `installInfo.connectUrl`.

**Tech Stack:** TypeScript 6, pnpm + turbo, Vitest, Playwright (system Chrome only), Expo (current stable SDK, expo-router, expo/fetch, expo-notifications, expo-image-picker), Chrome MV3 + Vite, Astro/Starlight docs.

**Spec:** `docs/superpowers/specs/2026-11-09-uncage-react-native-design.md`

## Global Constraints

- Branch `feat/react-native`; all public `@uncage/*` packages move together to **0.4.0** (fixed changeset group).
- `@uncage/hub` root stays Web-standard (`check-web-entry` must pass); `expoPushNotifier` lives in the root and uses only `fetch`.
- `@uncage/client` / `@uncage/react` must not import `react-native` or `expo-*`; RN specifics are adapters passed in by the app. A new package only if unavoidable (then `@uncage/react-native`, adapters only).
- Never touch the real `~/.uncage`, `~/Uncage`, LaunchServices, `~/.local/share/applications`, or HKCU on the user's Mac: tests use temp dirs and injected exec; no real URL handler registration, no real dialogs, no real background services.
- Never run real Codex, Gemini, OpenCode or npx registry agents; the only real agent allowed is the user's Claude Code (and the pinned claude-agent-acp).
- Never run a built CLI against the real environment (use `UNCAGE_HOME` temp dirs); never let a test reach a real `npm i -g` (inject `exec` / `upgradeCommand`).
- Windows system tools via `systemTool()` / commands via `resolveCommand` from `@uncage/protocol/node`; never `shell: true`.
- Dependencies: MIT / ISC / Apache-2.0 / BSD only; pin exact versions for new runtime deps.
- Every new docs page and change in **en, zh-cn, ja** (glossary `apps/docs/i18n-glossary.md`, strict `check-i18n`); site copy in `en.ts` / `zh.ts` / `ja.ts`; nothing unverified claimed (iOS links/push: "not verified on a device"; device features: "awaiting device confirmation" until the user confirms).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No paid accounts assumed (Expo Go; Android dev build via free EAS + free Firebase documented; Apple items configurable, unverified).

## Review Focus

1. A native-app request with no `Origin` and a bearer token, and a website request with a foreign `Origin` and a cookie: the first must work on every browser-API route, the second must still be refused (Task 3 test `device and session routes accept no-Origin bearer requests; foreign Origin still refused`).
2. The event stream after the app was backgrounded for minutes (stream torn down, fetch aborted): resuming must neither duplicate nor drop events (Task 1 test `reconnect() resumes after the last sequence without duplicates`).
3. `uncage://connect?url=` with hostile input — `javascript:`, `http://evil.com`, `https://user:pw@x`, IDN homographs, very long URLs, extra params: refuse or warn, never start a flow without the native confirmation (Task 6 tests).
4. The same approval arriving twice (agent resend) or on two hub nodes, and an agent backfilling hour-old events after reconnect: exactly one push, none for stale or resolved (Task 4 tests).
5. The dashboard reached by another local process or a web page (no token, wrong `Host`, DNS rebinding `Host: evil.com`): 403 for all (Task 7 test).

---

### Task 1: `@uncage/client` works in React Native

**Files:** Modify `packages/client/src/client.ts`, `packages/client/src/sse.ts`, `packages/client/src/index.ts`; Test `packages/client/src/rn.test.ts` (new).

**Interfaces — Produces:**
- `UncageClientOptions.headers?: () => Record<string, string> | Promise<Record<string, string>>`
- `UncageClient.uploadAttachment(sessionId, file: (Blob & { name: string }) | RNFile, opts?)`, `type RNFile = { uri: string; name: string; type: string }` (exported). RN path: `FormData`-free raw body via the provided `fetch` with `body: { uri, name, type }` is NOT standard — implement by reading the file through `fetch(uri)` → `blob()` when `file.uri` is given (works in RN/Expo), then the existing Blob path.
- `UncageClient.lookupDevice(code: string): Promise<DeviceLookup | null>`, `UncageClient.decideDevice(code: string, approve: boolean): Promise<'ok' | 'not_found' | 'expired'>` (types re-exported from `@uncage/protocol` or defined here to match the hub's `lookupDevice` result).
- `UncageClient.reconnect(): void` — immediately restarts every open event subscription from its last sequence (no-op when none).
- `InstallInfo.connectUrl?: string` (Task 3 fills it).

- [ ] Step 1: Write failing tests in `rn.test.ts` with a simulated RN env (delete `globalThis.location`, `localStorage`, `EventSource`; a `fetch` returning `Response` with a `ReadableStream` body like `expo/fetch`): `streams events with a body-reader fetch and no EventSource`, `async headers are awaited on every request and stream`, `uploads an RN file reference {uri,name,type}`, `reconnect() resumes after the last sequence without duplicates`, `lookupDevice / decideDevice call GET /device/lookup?code= and POST /device/decision`.
- [ ] Step 2: Run `pnpm --filter @uncage/client test -- rn` → FAIL.
- [ ] Step 3: Implement. If `TextDecoder` is undefined, fall back to an internal streaming UTF-8 decoder (multi-byte split safe; test `decodes split multi-byte UTF-8 without TextDecoder`).
- [ ] Step 4: Run tests + `typecheck` + `lint` → PASS; existing bundle-size test still passes.
- [ ] Step 5: Commit `feat(client): React Native ready (async headers, RN file uploads, reconnect, device approval)`.

### Task 2: `@uncage/react` hooks in React Native

**Files:** Modify `packages/react/src/hooks.ts`, `packages/react/src/index.ts`; Test `packages/react/src/rn.test.tsx` (new).

**Interfaces — Consumes:** Task 1 client methods. **Produces:**
- `type PersistSessionStorage = { get(): string | undefined | null | Promise<string | undefined | null>; set(id: string | undefined): void | Promise<void> }`; `PersistSessionMode = 'url' | 'localStorage' | false | PersistSessionStorage`. With `'url'` / `'localStorage'` and no `window.location` / `localStorage`: no-op, no throw.
- `useDeviceApproval(code: string): { lookup: DeviceLookup | null; state: 'loading' | 'idle' | 'approving' | 'denying' | 'approved' | 'denied' | 'not_found' | 'expired'; error?: { code: string; message: string }; approve(): Promise<void>; deny(): Promise<void> }`.
- `useReconnect(): () => void` (calls `client.reconnect()`; the app wires it to `AppState` 'active').

- [ ] Step 1: Failing tests: `usePersistSession with a storage adapter restores and saves`, `default persist mode is a safe no-op without window.location`, `useDeviceApproval loads, approves, maps not_found/expired and rate_limited errors`.
- [ ] Step 2–4: Run → FAIL; implement; run tests/typecheck/lint → PASS.
- [ ] Step 5: Commit `feat(react): storage-adapter session persistence and useDeviceApproval for React Native`.

### Task 3: Hub — device approval routes, `trustedOrigins`, `connectUrl`

**Files:** Modify `packages/hub/src/browser-api.ts`, `packages/hub/src/types.ts`, `packages/hub/src/hub.ts`, `packages/hub/src/install/*` (install info); Test `packages/hub/src/apps.test.ts` (new).

**Interfaces — Produces:**
- Routes (authenticated by `getUser`): `GET <base>/device/lookup?code=` → `json(await device.lookup(code, user))` (same result and same failed-code rate limit as `hub.lookupDevice`); `POST <base>/device/decision` body `{ code: string(1..32), approve: boolean }` → `{ result: 'ok' | 'not_found' | 'expired' }`.
- `HubOptions.trustedOrigins?: string[]` — exact origins (scheme://host[:port], validated at `createHub`, throw on wildcards/paths) allowed past `crossSite`.
- `InstallInfo.connectUrl: string` = `uncage://connect?url=<encodeURIComponent(setupUrl)>`.

- [ ] Step 1: Failing tests: `device and session routes accept no-Origin bearer requests; foreign Origin still refused`, `trustedOrigins lets chrome-extension://abc POST; other extension ids refused`, `createHub rejects trustedOrigins with wildcards or paths`, `device lookup/decision: approve binds, deny, not_found, expired, rate_limited after 10 bad codes`, `installInfo.connectUrl encodes the setup URL`.
- [ ] Step 2–4: FAIL → implement → PASS (`pnpm --filter @uncage/hub test`, typecheck, lint, build incl. check-web-entry).
- [ ] Step 5: Commit `feat(hub): device approval over HTTP, trustedOrigins, installInfo.connectUrl`.

### Task 4: Hub — `onAttention`, `claimOnce`, `expoPushNotifier`

**Files:** Create `packages/hub/src/attention.ts`, `packages/hub/src/push/expo.ts`; Modify `hub.ts` (ingest), `types.ts`, `index.ts`, `store/store.ts`, `store/sql.ts` (migration **9**: table `uncage_claims(key text primary key, expires_at timestamptz)`), `store/pglite.ts`, `store/postgres.ts`, `store/contract.ts`, `maintenance.ts` (prune expired claims); Test `attention.test.ts`, `push/expo.test.ts`, store contract additions.

**Interfaces — Produces:**
- `HubStore.claimOnce?(key: string, o: { ttlSec: number; now: string }): Promise<boolean>`.
- `type AttentionEvent = { kind: 'approval_requested' | 'run_completed' | 'run_failed'; userId: string; sessionId: string; sessionTitle?: string; machineId: string; machineName?: string; runtime?: string; approval?: { id: string; title: string; kind: string }; at: string }`.
- `HubOptions.onAttention?: (e: AttentionEvent, ctx: { waitUntil(p: Promise<unknown>): void }) => void | Promise<void>`.
- `expoPushNotifier(o: { tokensFor(userId: string): Promise<string[]>; accessToken?: string; fetch?: typeof fetch; message?(e: AttentionEvent): { title: string; body: string } | null; onInvalidToken?(token: string): void | Promise<void>; endpoint?: string }): NonNullable<HubOptions['onAttention']>` — POSTs batches of ≤ 100 to `https://exp.host/--/api/v2/push/send` (default endpoint), `data: { sessionId, approvalId?, kind }`; `DeviceNotRegistered` tickets → `onInvalidToken`.
- Rules: fire after ingest accepted the event (both `sessionStorage` modes); dedupe key `${sessionId}:${sequence}:${kind}`, `ttlSec` 86400; fallback per-node in-memory LRU (10 000 keys) when `claimOnce` absent; skip when `now - event.at > 10 min`; skip `approval_requested` when the stored snapshot shows it resolved (site mode); never block or fail ingest (errors → `logger.error`); run under the request's `waitUntil` when provided.

- [ ] Step 1: Failing tests: `fires once per approval, run.completed and run.failed`, `agent resend and a second node do not double-notify (claimOnce)`, `falls back to per-node dedupe without claimOnce`, `skips events older than 10 minutes and already-resolved approvals`, `a throwing onAttention never breaks ingest`, `uses waitUntil on FaaS`; expo: `batches 250 tokens into 3 requests`, `reports DeviceNotRegistered via onInvalidToken`, `message() null skips`; store contract `claimOnce returns true once per key until expiry` (PGlite + SQL + Postgres-docker path).
- [ ] Step 2–4: FAIL → implement → PASS (+ build/check-web-entry).
- [ ] Step 5: Commit `feat(hub): onAttention hook with cross-node dedupe and expoPushNotifier`.

### Task 5: CLI — QR code in `uncage setup`

**Files:** Modify `packages/cli/src/setup.ts`, `packages/cli/src/bin.ts` (help, `--no-qr`); Create `packages/cli/src/qr.ts` (encoder wrapper); Test `packages/cli/src/qr.test.ts`.

**Interfaces — Produces:** `renderQr(text: string): string` (compact half-block terminal QR); setup prints it under the link when `isTTY && !noQr`.

- [ ] Steps: failing tests `renders a decodable QR for the verification URL` (decode with the same lib or a known vector), `setup prints QR only on a TTY`, `--no-qr suppresses it` → implement (dependency choice: builder's, license-checked, exact pin) → PASS → commit `feat(cli): uncage setup shows the approval link as a QR code`.

### Task 6: One-click connect — `uncage connect`, site identity checks, OS URL handler

**Files:** Create `packages/cli/src/connect.ts`, `packages/cli/src/site-identity.ts`, `packages/cli/src/confirm-dialog.ts`, `packages/cli/src/service/url-handler.ts` (+ `url-handler.test.ts`); Modify `setup.ts` (export a reusable `pairSite` used by setup and connect), `bin.ts` (`connect` command, help), `agent-cmd.ts` / `setup.ts` install + uninstall paths (register / unregister handler); Tests `connect.test.ts`, `site-identity.test.ts`, `confirm-dialog.test.ts`.

**Interfaces — Produces:**
- `parseConnectLink(raw: string): { url: string } | { error: string }` — accepts `uncage://connect?url=…` or a bare https URL; refuses non-https except loopback http, credentials in URL, fragments-only junk, length > 2048.
- `siteIdentity(url: string, known: string[]): { origin: string; registrableDomain: string; displayHost: string; warnings: Array<'idn' | 'ip' | 'first_time' | 'lookalike'> ; lookalikeOf?: string }` (PSL dependency; lookalike = confusable skeleton equal or edit distance ≤ 2 on the registrable label vs `known`).
- `confirmConnect(i: ReturnType<typeof siteIdentity>, d: { platform; exec; isTTY; prompt? }): Promise<boolean>` — macOS `/usr/bin/osascript` `display dialog … buttons {"Cancel","Connect"} default button "Cancel"`; Windows `powershell.exe` via `systemTool` with `[System.Windows.MessageBox]` / WinForms MessageBox (default Cancel); Linux `zenity --question` or `kdialog --warningyesno` via `findCommand`; else TTY prompt; else `false`. Copy (en; zh/ja by locale): title `Connect this computer?`, body `Connect this computer to ${registrableDomain}?\n${origin}\nIt will be able to start coding-agent sessions on this computer when you use that site.` plus one line per warning.
- `uncage connect <url|uncage-link>`: parse → identity (known = registrable domains of `agent.yaml` sites) → confirm → `pairSite` (device flow, opens `/device?code=…`) → restart service if installed (else hint `uncage agent`). Exit codes: 0 connected, 1 refused/cancelled, 2 bad link.
- `registerUrlHandler(d: { platform; home; exec; spec })` / `unregisterUrlHandler(...)` in `service/url-handler.ts`: macOS bundle `~/Library/Application Support/Uncage/UncageConnect.app` (Info.plist with `CFBundleURLTypes` scheme `uncage`, `CFBundleIdentifier` `dev.uncage.connect`, executable script running pinned Node + CLI `connect "$1"`), register with `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f`; Linux `.desktop` (`Exec=<node> <cli> connect %u`, `MimeType=x-scheme-handler/uncage;`, `NoDisplay=true`) + `xdg-mime default uncage-connect.desktop x-scheme-handler/uncage`; Windows `reg add HKCU\Software\Classes\uncage` (`URL Protocol`, `shell\open\command` = `"<node>" "<cli>" connect "%1"`). Called at the end of `installAgentService`, removed by `uncage agent uninstall`. macOS app bundle receives the URL via Apple Events, not argv: the bundle's executable must be a tiny compiled AppleScript applet (`osacompile` an `on open location theURL` handler that runs the pinned command) — builder verifies the mechanism on macOS in CI (`macos-latest`) without registering on the user's Mac.

- [ ] Step 1: Failing tests (all with temp homes and fake exec): `parseConnectLink refuses javascript:, http non-loopback, credentials, >2048`, `siteIdentity flags idn (xn--), ip, first_time, lookalike (examp1e.com vs example.com)`, `confirmConnect builds the osascript/powershell/zenity/kdialog command per OS and returns false when nothing can ask`, `connect never starts a device flow when the dialog is cancelled`, `connect pairs against a real test hub after confirm and restarts the service`, `register/unregister write and remove the handler files/keys per OS`.
- [ ] Step 2–4: FAIL → implement → PASS (cli tests, typecheck, lint). CI three-OS job runs the real registration against the runner's own temp home / a throwaway HKCU key (cleaned up).
- [ ] Step 5: Commit `feat(cli): one-click connect (uncage:// handler, uncage connect, native confirmation with site identity checks)`.

### Task 7: Local dashboard — `uncage dashboard`

**Files:** Create `packages/cli/src/dashboard/server.ts`, `dashboard/page.ts` (HTML/CSS/JS strings, en/zh-CN/ja), `dashboard/actions.ts`; Modify `bin.ts`; Test `dashboard/server.test.ts`, `e2e/dashboard.spec.ts` (Playwright, system Chrome, temp `UNCAGE_HOME`, test hub).

**Interfaces — Produces:** `startDashboard(d: { home; exec; open?: boolean; idleMs?: number /* 1_800_000 */ }): Promise<{ url: string; close(): Promise<void> }>` — `127.0.0.1:0`, 32-byte token in `?t=` then an HttpOnly SameSite=Strict cookie; every request needs the token and `Host === 127.0.0.1:<port>`; JSON `GET /api/sites` (name, domain, machineId, connectedAt, online/transport from agent status, runtimes, last 20 redacted activity entries), `POST /api/sites/:id/disconnect` (same as `uncage sites remove`: revoke on hub, remove locally, restart agent), `POST /api/runtimes/:id/enable|disable` (same consent rules as `uncage runtimes`); exits on idle.

- [ ] Steps: failing tests `403 without token, with wrong Host (rebinding), from another origin`, `lists sites with domain and status`, `disconnect revokes on the hub and removes the site`, `runtime toggle respects consent rules`, Playwright `dashboard shows the connected test site and disconnects it` → implement → PASS → commit `feat(cli): uncage dashboard — local page for connected sites, status, activity and disconnect`.

### Task 8: `@uncage/react-ui` — one-click connect in `<ConnectMachine>`

**Files:** Modify `packages/react-ui/src/components/ConnectMachine.tsx`, `i18n.ts`, styles; Test `connected.test.tsx`.

- [ ] Steps: failing tests `shows "Already use Uncage on this computer? Connect in one click" linking installInfo.connectUrl on macOS/Linux/Windows tabs`, `hidden when connectUrl is absent or on mobile user agents` → implement (en / zh-CN strings; ja if react-ui has ja) → PASS → commit `feat(react-ui): one-click connect link in ConnectMachine`.

### Task 9: connected-demo — app auth, push, links, extension origin

**Files:** Modify `examples/connected-demo` (auth: accept `Authorization: Bearer <app token>` in `getUser`; `POST /api/app/token` issuing an HMAC app token for the signed-in/guest user; `POST /api/app/push-token` storing Expo push tokens per user in both stores; hub `onAttention: expoPushNotifier({ tokensFor })` when `EXPO_PUSH=1`; `trustedOrigins` from `TRUSTED_ORIGINS`; `/.well-known/assetlinks.json` from `ANDROID_PACKAGE` + `ANDROID_SHA256`; `/.well-known/apple-app-site-association` from `APPLE_TEAM_ID` + `IOS_BUNDLE_ID`; `DEPLOY.md` section). Tests in `lib/*.test.ts`.

- [ ] Steps: failing tests `bearer app token resolves the same user as the cookie`, `invalid/expired app token → 401 JSON`, `push tokens stored per user, both stores`, `well-known files only when env set, correct JSON shape` → implement → PASS → commit `feat(connected-demo): app tokens, Expo push, app links and trusted origins`.

### Task 10: `examples/connected-expo`

**Files:** Create `examples/connected-expo/` (Expo current stable SDK, TypeScript, expo-router): `app/(auth)/sign-in.tsx`, `app/index.tsx` (computers + sessions), `app/chat/[id].tsx` (messages, tool steps, approval cards Allow once / Deny, runtime / model / effort / permission pickers, photo attach via expo-image-picker, images with `Image source={{ uri, headers }}`), `app/device.tsx` (useDeviceApproval; opened by `/device?code=` link), `lib/uncage.ts` (`createUncageClient({ baseUrl, fetch: expo/fetch, headers: async () => bearer })`, SecureStore persistence), `lib/push.ts` (expo-notifications → `/api/app/push-token`), `app.json` (scheme, `intentFilters` for `/device`, `associatedDomains` placeholders), `eas.json` (development profile, Android APK), `README.md` (Expo Go steps; free Android dev build with EAS + Firebase; iOS notes "not verified"). Workspace: add to pnpm workspace, excluded from changesets.

- [ ] Steps: `pnpm --filter connected-expo typecheck`, `lint`, `expo export --platform android` and `--platform ios` succeed (no device needed); a Jest/Vitest test for `lib/uncage.ts` (headers + persistence adapters) → commit `feat(examples): connected-expo React Native app`.

### Task 11: `examples/connected-extension`

**Files:** Create `examples/connected-extension/` (MV3, Vite): `manifest.json` (side_panel, host_permissions from build env `HUB_ORIGIN`), `src/panel.tsx` (`<UncageProvider client={createUncageClient({ baseUrl: HUB_ORIGIN + '/api/uncage', fetch: (u, i) => fetch(u, { ...i, credentials: 'include' }) })}><AgentChat /></UncageProvider>`), `README.md` (load unpacked, set `TRUSTED_ORIGINS=chrome-extension://<id>` on the hub). Test: Playwright in system Chrome loading the unpacked extension against the mock connected stack, if Chrome allows extension loading headful in CI; otherwise build-only in CI and a local Playwright run.

- [ ] Steps: build → test → commit `feat(examples): connected-extension Chrome side panel`.

### Task 12: Docs, site, release

**Files:** apps/docs (en/zh-cn/ja): new `guides/react-native.md`, `guides/authenticate-apps.md`, `guides/push-notifications.md`, `guides/browser-extension.md`, `guides/one-click-connect.md` (incl. site identity checks, `uncage dashboard`), updates to `reference/http-api.md` (device routes), `guides/mount-the-hub.md` (options `trustedOrigins`, `onAttention`), `reference/cli.md` (`connect`, `dashboard`, `--no-qr`), `reference/security.md` (one-click threat model, dashboard), `start/install-on-your-computer.md`, nav; `apps/site` (en/zh/ja): "More entry points" → mobile apps + browser extensions available (chat apps stay Coming soon), a "One agent, every site" feature; `docs/compatibility.md` records; changeset **minor** for all public packages → 0.4.0 via `pnpm changeset version`; CHANGELOG + docs changelog 0.4.0; release branch `release/0.4.0`, full verification, push, PR body.

- [ ] Steps: write docs → strict check-i18n + docs tests + `build:web && check:web` → site tests + site e2e (system Chrome, 320–375 px) → changeset + version → full `pnpm build && typecheck && lint && turbo run test --concurrency=1 && e2e:mock` → push branch → PR body with acceptance checklist.
