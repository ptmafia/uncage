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

Hooks: `useRuntimes`, `useSessions`, `useSession`, `useRun`, `useMessages`, `useApprovals`, `useApprovalActions`, `useRuntimeCapabilities`, `useSessionSettings`, `useAttachments`, `useAttachmentUrl`, `useRunningSessions`, `useSpeechInput`, `useConnection`, `useUncageError`, `useUncageStore`, `useMachines`. Every export has JSDoc and full TypeScript types.

Before the first prompt there is no session: call `useUncageStore().actions.openDraft(runtimeId)`, then on send `commitDraft()` → `selectSession(id)` → `sendPrompt(text)`.

`useMachines({ watch? })` is for Connected Mode (an `@uncage/hub` website): it probes `GET /machines` once (a local daemon answers 404 → `mode: 'local'`, nothing else changes), lists the user's computers with `online`, the `selected` one new sessions run on (`select(id)`), `current` (the open session's computer when known), `install` commands (`loadInstallInfo()`) and `revoke(id)`. `watch: true` polls every 3 s while the page is visible.

Needs the same server setup as `@uncage/react-ui` (a running `uncage serve` and the `/api/uncage/*` proxy route from `@uncage/server/proxy`).

---

Part of **Uncage** — bring Claude Code (and Codex) into your own app with approvals, streaming and a ready-made UI. Start with [`@uncage/react-ui`](https://www.npmjs.com/package/@uncage/react-ui) for the 5-minute setup. MIT licensed.
