# Uncage for React Native apps (and browser extensions) — design

Status: approved direction, pending final read · 2026-11-09 · branch `feat/react-native`

## Intent

Uncage is a framework: developers embed it so *their* users drive *their own* coding agent (Claude Code, Codex, any ACP agent) on their own computer. Until now the only entry point was a website. This project makes a **developer's own React Native app** a first-class entry point, plus a browser extension example, so the same user agent serves every surface the developer ships.

Why it matters (user's words, paraphrased): the long-term moat is "one agent, every site/app": a user installs the Uncage agent once and every product that embeds Uncage can use it. Each new entry point we support makes integrating Uncage worth more to developers. The app belongs to the developer; we ship the SDK.

## Goals

1. **React Native SDK.** `@uncage/client` and `@uncage/react` (headless hooks) work unchanged in an Expo / React Native app: list computers, start sessions on a computer, stream events, answer approvals, pick runtime / model / effort / permission mode, send text and photo attachments, resume after the app was backgrounded.
2. **App authentication guide.** How a developer's `getUser(req)` authenticates app requests with a bearer token they already issue (no cookies), in en / zh-CN / ja.
3. **Expo example app** (`examples/connected-expo`) against `examples/connected-demo` (or any hub): sign in, chat, computer picker, approval cards, runtime picker, offline state, push, QR approval. It's a reference to copy, not a component library.
4. **Approval push notifications.** The hub calls a developer hook when a user's attention is needed (an approval was requested; a run finished or failed), so the developer can send a push through their own provider. Ship a ready Web-standard helper for **Expo Push**.
5. **Scan to connect a computer.** `uncage setup` also prints the approval link as a terminal QR code; the developer maps the hub's verification path (`/device`) to the app with universal / app links, so a phone scan opens the app's approval screen (falling back to the mobile web page).
6. **Browser extension example** (`examples/connected-extension`, Chrome Manifest V3 side panel) using `@uncage/react-ui` against a hub, with the hub accepting its origin explicitly.
7. Docs (3 locales), site card "More entry points" updated (mobile apps + browser extensions available; chat apps stay "Coming soon"), changeset (minor → 0.4.0? see open choices).

## Non-goals

- A React Native UI component library (`@uncage/react-native-ui`). The example app shows how to build the UI with the headless hooks; a component library is a possible follow-up.
- Flutter, native iOS / Android SDKs (the HTTP API is documented; no SDKs now).
- Chat-app bots (Slack, Feishu, Telegram): separate project (needs a server-side session API and account linking).
- The "one agent everywhere" items (one-click connect via `uncage://`, user-side dashboard of connected sites, site verification): separate next project.
- An official Uncage mobile app or relay service.

## Anti-goals

- Anything that makes the app hold the user's machine token or talk to the computer directly. The app only ever talks to the developer's backend (the hub); the agent keeps dialing out to the hub as today.
- Weakening the hub's cross-site protection for websites to make extensions work.
- Claiming device support we haven't verified (no Xcode / Android SDK on the build machine: see Verification).

## What exists (from the code)

- `createUncageClient({ baseUrl, fetch, headers })` already accepts a custom `fetch` and per-request headers (`packages/client/src/client.ts`). Events stream through `fetch` + `response.body.getReader()` + `TextDecoder` (`sse.ts`), not `EventSource`.
- The hub's browser API only refuses state-changing requests whose `Origin` is present and not the site's (`browser-api.ts` `crossSite`). Native apps send no `Origin` → allowed. Extensions send `Origin: chrome-extension://<id>` → refused today.
- `getUser(req)` is entirely the developer's: it can read `Authorization: Bearer …`.
- `@uncage/react` `usePersistSession` reads `window.location` / `localStorage` (`hooks.ts:309-352`): not available in RN. `speech.ts` is guarded.
- `uploadAttachment` posts a `Blob` body: RN needs a file-URI path.
- Hub sees every agent event in `ingest` (`hub.ts` ~260-295), including `approval.requested`, `run.completed`, `run.failed` → natural place for the attention hook (both `sessionStorage` modes must fire it).
- `uncage setup` prints `verificationUri` + user code (`cli/src/setup.ts:67`).

## Decisions

### SDK (client + react)
- **Streaming fetch:** RN's built-in `fetch` cannot stream response bodies. Document and test with Expo's `expo/fetch` (streams `response.body`), passed as `createUncageClient({ fetch })`. Bare RN: any streaming fetch polyfill with `body.getReader()`. The client must not depend on anything else browser-only (check `TextDecoder` availability on Hermes; if missing, fall back to a small UTF-8 decoder or document the polyfill: builder's call, must work in Expo SDK current stable on Hermes).
- **Auth headers:** existing `headers: () => ({ authorization: 'Bearer …' })`. If the token can refresh, `headers` may be async: allow `() => Record | Promise<Record>`.
- **Session persistence:** `PersistSessionMode` gains a storage adapter form: `{ get(): string | undefined | Promise<…>; set(id: string | undefined): void | Promise<void> }` (e.g. AsyncStorage / SecureStore). Default stays `'url'` on the web; in RN (no `window.location`) the default must be a safe no-op, never a crash.
- **Attachments:** `uploadAttachment` accepts, besides `Blob & { name }`, an RN file reference `{ uri, name, type }` (from the image picker). Implementation is the builder's call, but photos picked in the example app must upload and render; `attachmentUrl` needs the auth header, so the example renders images with `Image source={{ uri, headers }}`.
- **Background / foreground:** when the app returns to the foreground, the event stream resumes from the last sequence with no gap (it already reconnects with `Last-Event-ID`; verify with an AppState-driven pause/resume and expose a small `client.reconnect()` / hook if needed).
- No new RN-only package unless the above can't live in `@uncage/client` / `@uncage/react` without pulling RN into web bundles. If something RN-specific is unavoidable, a tiny `@uncage/react-native` (adapters only) is acceptable.

### Hub
- **`trustedOrigins?: string[]`** in `HubOptions`: extra origins (e.g. `chrome-extension://<id>`) allowed past the cross-site guard. Exact-match only, no wildcards; documented as "only origins you control".
- **`onAttention?: (e: AttentionEvent, ctx: { waitUntil }) => void | Promise<void>`** in `HubOptions`. `AttentionEvent = { kind: 'approval_requested' | 'run_completed' | 'run_failed'; userId; sessionId; sessionTitle?; machineId; machineName?; runtime; approval?: { id; title; kind }; at }`. Fired once per event per hub (dedupe on the event id/sequence so agent resends and multiple nodes don't double-notify), after the event is stored, never blocking ingest (errors logged). On FaaS it runs under `waitUntil`.
- **`expoPushNotifier({ tokensFor(userId), accessToken?, fetch? })`** exported from the root (Web-standard): returns an `onAttention` handler that sends localized-agnostic English default messages (overridable `message(e)`), batches tokens, and reports invalid tokens through an optional `onInvalidToken(token)`.
- Push tokens live in the developer's own database; the hub never stores them.
- **`onAttention` in both `sessionStorage` modes** (my call): fire from ingest whether or not events are stored. Dedupe key = `sessionId:sequence:kind`, claimed once through a new **optional** `HubStore.claimOnce(key, ttlSec): Promise<boolean>` (implemented in the SQL / Postgres / PGlite stores with a migration, 24 h retention via maintenance). A custom store without it falls back to per-node in-memory dedupe (best effort, documented). **Stale suppression:** skip events whose timestamp is older than 10 min (agent backfill after reconnect), and skip `approval_requested` when the approval is already resolved (site mode: from the stored snapshot).
- **Device approval over HTTP** (my call): new browser-API routes so apps don't hand-write an endpoint: `GET <base>/device/lookup?code=` → same result as `hub.lookupDevice(code, user)`; `POST <base>/device/decision` `{ code, approve }` → `approveDevice` / `denyDevice`. Authenticated by `getUser`, same failed-code rate limit as `lookupDevice`, behind the cross-site guard (POST from a foreign `Origin` refused; native apps send none). Client methods `lookupDevice(code)` / `decideDevice(code, approve)` and a headless `useDeviceApproval(code)` hook. Websites keep their existing Server Action pattern; both work.

### CLI
- `uncage setup` prints a compact terminal QR code of the verification URL (with the code) under the link; `--no-qr` turns it off; skipped when stdout isn't a TTY. Small dependency or an in-repo encoder: builder's call (license MIT/ISC/Apache only).

### Examples
- `examples/connected-expo`: Expo (current stable SDK, TypeScript, expo-router). Screens: sign-in (token against connected-demo; add a small token endpoint to connected-demo for app sign-in, dev-only guest token allowed), computers, chat (messages, tool steps, approval cards Allow once / Deny, runtime/model/effort/permission pickers, photo attach), device approval screen opened by a universal link to `/device?code=…`, push registration (expo-notifications) wired to connected-demo's `onAttention` via `expoPushNotifier`.
- `examples/connected-extension`: MV3 side panel, Vite build, `@uncage/react-ui` `<AgentChat>` against a hub URL, using cookies of the site (`credentials: 'include'` + host permission) and the hub's `trustedOrigins`.

## Verification

- Unit tests: client + hooks in a simulated RN environment (no `window.location` / `localStorage`, a streaming fetch shaped like `expo/fetch`, file-URI uploads, async headers, storage adapter), hub `onAttention` (each kind, dedupe across resend and two nodes, waitUntil on FaaS), `trustedOrigins`, `expoPushNotifier` (batching, invalid tokens) against a fake Expo endpoint, CLI QR (TTY / non-TTY / `--no-qr`).
- Example apps: type-check and build (`expo export` for the app; Vite build for the extension) in CI. The extension also gets a Playwright run in system Chrome (load unpacked, side panel chat against the mock hub) if feasible.
- **Real device, free path only (user decision: "尽量先用免费方案"):** no Xcode / Android SDK on this machine, no paid accounts.
  - **Expo Go** (free): chat, computers, approvals, pickers, photo attach, background/foreground resume. The user scans the dev server QR against a locally running connected-demo with real Claude Code.
  - **Push and app links need a development build.** Prepare everything for the free route: a free Expo account + EAS project (free build tier) for an **Android** development build (APK, no paid account needed), a free Firebase project for FCM, and connected-demo serving `/.well-known/assetlinks.json` from an env-configured package name + SHA-256 fingerprint. Step-by-step instructions in the example README.
  - **iOS universal links and iOS push** need a paid Apple Developer account: implemented and configurable (`apple-app-site-association` from env Team ID + bundle id), documented as "not verified on a device". On iOS the QR falls back to the mobile web approval page.
  - Docs say "verified on <device>" only for what the user actually confirmed; everything else: "built and unit-tested; awaiting device confirmation".

## Open choices (builder settles; marked as such)

- Version: new public API (`trustedOrigins`, `onAttention`, `expoPushNotifier`, storage adapter) → **0.4.0** (my call; pre-1.0 minor = features).
- Whether a tiny `@uncage/react-native` package is needed (only if RN code can't live in the existing packages without leaking into web bundles).
- QR encoder choice.
