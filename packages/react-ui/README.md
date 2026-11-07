# @uncage/react-ui

The default Uncage chat UI for React 19: `<AgentChat>` gives you a session sidebar, runtime picker, streaming markdown, tool steps, Allow/Deny approval cards, Stop, reload-safe history, and a Claude Code–style composer (model, effort and permission-mode menus, image/file attachments by button, drag and drop or paste, browser voice input, a "N running" chip).

## Quick start (Next.js)

```sh
npm i @uncage/server @uncage/react-ui @uncage/cli
npx uncage serve --workspace /path/to/project   # keep running; needs Claude Code installed and logged in
```

```ts
// app/api/uncage/[...path]/route.ts
import { createUncageHandler } from '@uncage/server/proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST, PATCH } = createUncageHandler();
```

```tsx
// app/page.tsx
'use client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

export default function Page() {
  return (
    <div style={{ height: '100vh' }}>
      <UncageProvider><AgentChat locale="zh-CN" /></UncageProvider>
    </div>
  );
}
```

Then `npm run dev` and open http://localhost:3000. `npx uncage doctor` checks your setup and prints a fix for every problem.

## Customizing

- `locale`: `'en'` (default) or `'zh-CN'`. `theme`: `'auto'` (default), `'light'`, `'dark'`.
- Restyle with the `--uncage-*` CSS variables; every class uses the `uc-` prefix.
- Replace parts via the `components` prop, or build your own UI with the hooks in [`@uncage/react`](https://www.npmjs.com/package/@uncage/react).
- `bypassPermissions` (no approvals) is only offered when the daemon is started with `UNCAGE_ALLOW_BYPASS=1`; choosing it asks for confirmation.
- Attachments: images png/jpg/gif/webp (≤5 MB for Claude), text/code files and PDF (≤10 MB), 10 per message.

---

Part of **Uncage** — bring Claude Code (and Codex) into your own app with approvals, streaming and a ready-made UI. Start with [`@uncage/react-ui`](https://www.npmjs.com/package/@uncage/react-ui) for the 5-minute setup. MIT licensed.
