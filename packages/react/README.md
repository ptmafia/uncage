# @uncage/react

Headless React 19 hooks and a framework-agnostic store for Uncage. Use them to build your own agent UI; [`@uncage/react-ui`](https://www.npmjs.com/package/@uncage/react-ui) is built entirely on top of them.

```tsx
import { UncageProvider, useRun, useMessages, useApprovals, useApprovalActions } from '@uncage/react';

function Chat() {
  const { send, cancel, isActive } = useRun();
  const { timeline, messages } = useMessages();
  const { pending } = useApprovals();
  const { decide } = useApprovalActions();
  // render timeline; call send(text), cancel(), decide(id, 'allow' | 'deny')
}

export default () => <UncageProvider><Chat /></UncageProvider>;
```

Hooks: `useRuntimes`, `useSessions`, `useSession`, `useRun`, `useMessages`, `useApprovals`, `useApprovalActions`, `useRuntimeCapabilities`, `useSessionSettings`, `useAttachments`, `useAttachmentUrl`, `useRunningSessions`, `useSpeechInput`, `useConnection`, `useUncageError`, `useUncageStore`, `useMachines`, `usePersistSession`, `useDeviceApproval`, `useReconnect`. Every export has JSDoc and full TypeScript types.

Before the first prompt there is no session: call `useUncageStore().actions.openDraft(runtimeId)`, then on send `commitDraft()` → `selectSession(id)` → `sendPrompt(text)`.

`useMachines({ watch? })` is for Connected Mode (an `@uncage/hub` website): it probes `GET /machines` once (a local daemon answers 404 → `mode: 'local'`, nothing else changes), lists the user's computers with `online`, the `selected` one new sessions run on (`select(id)`), `current` (the open session's computer when known), `install` commands (`loadInstallInfo()`) and `revoke(id)`. `watch: true` polls every 3 s while the page is visible.

`usePersistSession(mode)` remembers the open session across reloads: `'url'` (`?session=`, the default in `<AgentChat>`), `'localStorage'`, `false`, or a `PersistSessionStorage` adapter `{ get(), set(id) }` (sync or async, e.g. SecureStore / AsyncStorage in React Native; an inline object is fine). Restore is asynchronous and skipped when a draft is already open.

`useDeviceApproval(code, { source? })` is a headless approve screen for a new computer (e.g. on a phone): `lookup` (with `requestedAt` and `requestIp`), `state` (`'loading'` → `'idle'` → `'approving'` / `'denying'` → `'approved'` / `'denied'`, or `'not_found'` / `'expired'` / `'error'`), `error`, `confirmation`, `approve()`, `deny()` and `retry()` (re-runs a failed lookup). A code that arrived in a link (`source: 'link'`, the default) is not trusted on its own: `approve()` does nothing until the user typed the code's last 4 characters into `confirmation.setTyped` (`confirmation.matched`). Show the warning "Only approve if you just ran `uncage setup` on a computer in front of you. Never approve a code someone sent you." with the request time and IP. Pass `source: 'typed'` only when the user typed the whole code; `deny()` never needs the extra step. A link code that is not exactly `ABCD-EFGH` / `ABCDEFGH` is not looked up (`state: 'not_found'`, `linkInvalid: true`). Calling `approve()` on an unconfirmed link code logs one `console.warn` (the default changed in 0.4.1). `deviceCodeTail`, `matchesDeviceCodeTail`, `isWellFormedDeviceCode` and `maskDeviceCode` (`ABCD-••••`, from the compacted code) are exported for your own screens. `useReconnect()` returns a function that restarts the event stream now: wire it to `AppState` `'active'` in React Native (pass `{ force: true }` to restart a healthy stream too).

`useAttachments().add(files)` and `actions.addAttachments(files)` take browser `File`s or, in React Native, picked file references `{ uri, name, type, size? }` (`AttachmentFile`). See [React Native apps](https://uncage-dev.vercel.app/docs/guides/react-native/).

Needs the same server setup as `@uncage/react-ui` (a running `uncage serve` and the `/api/uncage/*` proxy route from `@uncage/server/proxy`).

---

Part of **Uncage** — bring Claude Code (and Codex) into your own app with approvals, streaming and a ready-made UI. Start with [`@uncage/react-ui`](https://www.npmjs.com/package/@uncage/react-ui) for the 5-minute setup. MIT licensed.
