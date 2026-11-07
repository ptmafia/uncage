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
- `persistSession`: `'url'` (default) keeps the open session in `?session=<id>` so a reload reopens it; `'localStorage'` keeps the URL clean; `false` leaves it to your router.
- Restyle with the `--uncage-*` CSS variables; every class uses the `uc-` prefix.
- Replace parts via the `components` prop, or build your own UI with the hooks in [`@uncage/react`](https://www.npmjs.com/package/@uncage/react).
- `bypassPermissions` (no approvals) is only offered when the daemon is started with `UNCAGE_ALLOW_BYPASS=1`; choosing it asks for confirmation.
- Attachments: images png/jpg/gif/webp (≤5 MB for Claude), text/code files and PDF (≤10 MB), 10 per message.

## Connected Mode (users connect their own computer)

When `UncageProvider`'s `baseUrl` is an [`@uncage/hub`](https://www.npmjs.com/package/@uncage/hub) (it serves `/machines`), `<AgentChat>` switches on its own:

- the header shows the computer the conversation runs on (online dot, name) with a picker and "Connect another computer…";
- with no computer yet, the empty state is `<ConnectMachine>`: the install command, `uncage setup <url>`, copy buttons and a live "Waiting for your computer…" → "Connected: <name>" (it polls every 3 s while shown);
- while the computer is offline the composer is disabled: "Your computer is offline. Waiting for it to reconnect…" with the hint `uncage agent`.

Against a local daemon (`uncage serve`, no `/machines`) nothing changes.

`<ConnectMachine onConnected onClose />` (a dialog; `variant="inline"` to embed) and `<MachineStatus />` can be used on their own inside `UncageProvider`.

`uncage setup` sends the user to your website's approval page (`/device?code=…` by default). Render it with `<ApproveDevice>`; it is presentational, the decision is made server-side with the signed-in user. A Next.js example:

```tsx
// app/device/page.tsx (server component)
import { hub, currentUser } from '@/lib/uncage'; // your createHub(...) instance and auth
import { ApprovePage } from './approve-page';

export default async function Page({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code = '' } = await searchParams;
  const user = await currentUser();
  const lookup = await hub.lookupDevice(code, user); // { name?, os?, repairsMachine } | null
  return <ApprovePage code={code} lookup={lookup} />;
}

// app/device/actions.ts
'use server';
import { hub, currentUser } from '@/lib/uncage';
export async function decide(code: string, approve: boolean) {
  const user = await currentUser();
  try {
    return { result: await (approve ? hub.approveDevice(code, user) : hub.denyDevice(code, user)) }; // 'ok' | 'not_found' | 'expired'
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { error: { code: err.code ?? 'internal_error', message: err.message ?? 'Failed' } }; // e.g. rate_limited
  }
}

// app/device/approve-page.tsx
'use client';
import { useState } from 'react';
import { ApproveDevice, type ApproveDeviceProps, type ApproveDeviceState } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';
import { decide } from './actions';

export function ApprovePage({ code, lookup }: Pick<ApproveDeviceProps, 'code' | 'lookup'>) {
  const [state, setState] = useState<ApproveDeviceState>('idle');
  const [error, setError] = useState<ApproveDeviceProps['error']>();
  const act = async (approve: boolean) => {
    setState(approve ? 'approving' : 'denying');
    setError(undefined);
    const r = await decide(code, approve);
    if (r.error) {
      setState('idle'); // buttons stay enabled for a retry
      setError(r.error as ApproveDeviceProps['error']);
    } else {
      setState(r.result === 'ok' ? (approve ? 'approved' : 'denied') : r.result!);
    }
  };
  return <ApproveDevice code={code} lookup={lookup} state={state} error={error} locale="zh-CN"
    onApprove={() => void act(true)} onDeny={() => void act(false)} />;
}
```

Errors such as `machine_offline`, `machine_not_found` and `rate_limited` are shown in the UI language.

---

Part of **Uncage** — bring Claude Code (and Codex) into your own app with approvals, streaming and a ready-made UI. Start with [`@uncage/react-ui`](https://www.npmjs.com/package/@uncage/react-ui) for the 5-minute setup. MIT licensed.
