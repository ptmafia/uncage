---
title: Custom UI with hooks
description: Customize AgentChat (locale, theme, components, CSS variables) or build your own chat and connect-your-computer flow from the headless @uncage/react hooks, in Connected and Local Mode.
---

You can stop at any of three levels:

1. **`<AgentChat>`** (`@uncage/react-ui`) as it is, restyled and with some parts replaced.
2. **The parts** of `@uncage/react-ui` (`<ConnectMachine>`, `<MachineStatus>`, `<ApproveDevice>`, `<ApprovalCard>`, `<Composer>`, …) in your own layout.
3. **Headless hooks** (`@uncage/react`): your own components on top of the same store.

All of them work in both modes. The store finds out which mode it is in by asking the server for `/machines`: a hub answers (Connected Mode), a local daemon answers 404 (Local Mode).

## 1. Customize `<AgentChat>`

```tsx title="chat.tsx"
'use client';
import { AgentChat, UncageProvider, type ChatComponents } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

const EmptyState: ChatComponents['EmptyState'] = () => <p>Ask me to build something on your site.</p>;

export function Chat() {
  return (
    <UncageProvider baseUrl="/api/uncage">
      <AgentChat
        locale="zh-CN"
        theme="light"
        sidebar={false}
        starterPrompts={['做一个介绍我们产品的落地页并发布']}
        persistSession="localStorage"
        components={{ EmptyState }}
      />
    </UncageProvider>
  );
}
```

| Prop | Default | |
| --- | --- | --- |
| `locale` | `'en'` | `'en'` or `'zh-CN'` |
| `theme` | `'auto'` | `'light'`, `'dark'` or `'auto'` (follows the OS) |
| `sidebar` | `true` | The session list |
| `defaultRuntime` | first available | Runtime id for new sessions, e.g. `'claude'` |
| `starterPrompts` | none | Buttons on the empty state |
| `showTools` | `true` | Tool steps between messages |
| `persistSession` | `'url'` | Reopen the session after a reload: `?session=<id>`, `'localStorage'`, or `false` |
| `components` | | Replace `UserMessage`, `AssistantMessage`, `ToolSteps`, `ApprovalCard`, `Composer`, `EmptyState` |
| `className` | | On the root element |

Restyle with the `--uncage-*` CSS variables; every class has the `uc-` prefix. `UncageProvider`’s `baseUrl` defaults to `/api/uncage`; set it if you mounted the hub (or the Local Mode proxy) elsewhere.

In Connected Mode `<AgentChat>` also:

- shows `<ConnectMachine variant="inline">` as the empty state while the user has no computer;
- shows the computer of the open conversation in the header (`<MachineStatus>`), with a picker and “Connect another computer…”;
- disables the composer while that computer is offline (“Your computer is offline. Waiting for it to reconnect…”).

## 2. Use the parts

`<ConnectMachine>` is the “Connect your computer” flow on its own: the one install command in “macOS / Linux” and “Windows” tabs (it starts on the visitor’s OS), `uncage setup <url>` for a computer that already has the CLI, copy buttons, a live “Waiting for your computer…” → “Connected: &lt;name&gt;” (it polls every 3 s while shown), and help for computers that cannot open a browser. Put it on a settings page, an onboarding step, or a dialog:

```tsx title="connect-button.tsx"
'use client';
import { ConnectMachine, UncageProvider, type ConnectMachineProps } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';
import { useState } from 'react';

export function ConnectButton({ onConnected }: Pick<ConnectMachineProps, 'onConnected'>) {
  const [open, setOpen] = useState(false);
  return (
    <UncageProvider>
      <button type="button" onClick={() => setOpen(true)}>
        Connect your computer
      </button>
      {open && (
        <ConnectMachine
          onClose={() => setOpen(false)}
          onConnected={(machine) => {
            onConnected?.(machine);
            setOpen(false);
          }}
        />
      )}
    </UncageProvider>
  );
}
```

`variant="dialog"` (default) is a modal with Cancel, Esc and backdrop click; `variant="inline"` embeds it in the page. `<MachineStatus onSelect>` is the header’s computer menu. `<ApproveDevice>` is the `/device` page ([guide](/docs/guides/auth-and-device-approval/)). All of them must be inside an `UncageProvider`, except `<ApproveDevice>`, which is presentational.

## 3. Headless hooks

Wrap your app in `<UncageProvider>` (from `@uncage/react` or `@uncage/react-ui`) and use these hooks:

| Hook | Returns | Use it for |
| --- | --- | --- |
| `useMachines({ watch? })` | `{ mode, connected, machines, selected, current, currentId, loading, error, install, select(id), refresh(), revoke(id), loadInstallInfo() }` | Connected Mode: the user’s computers, which one new sessions use (`selected`), which one the open session runs on (`current`), the install commands. `watch: true` polls every 3 s while the page is visible. |
| `useRuntimes()` | `{ runtimes, loading }` | Runtime picker: `status` is `available`, `not_installed`, `auth_required`, …, with `hint` and `installUrl` |
| `useSessions()` | `{ sessions, activeSessionId, loading, select(id), create(body), reload() }` | Session list, new chat |
| `usePersistSession(mode = 'url')` | `void` | Reopen the last session on reload |
| `useSession()` | `{ session, connection, replayIncomplete }` | Header, connection banner. `session.machineId` in Connected Mode |
| `useRun()` | `{ run, isActive, send(prompt), cancel() }` | Composer and Stop. `send` resolves `true` once the run is accepted |
| `useMessages()` | `{ timeline, messages, tools }` | The conversation, in order |
| `useApprovals()` | `{ pending, all }` | Approval cards |
| `useApprovalActions()` | `{ decide(id, 'allow' \| 'deny'), pending }` | Allow and Deny, with per-card in-flight state |
| `useSessionSettings()` | `{ settings, capabilities, update(patch), pendingForNextRun }` | Model, effort and permission-mode pickers |
| `useAttachments()` | `{ items, add(files), remove(localId), clear(), ready, rejected }` | Attach button and chips |
| `useAttachmentUrl(id)` | `string` | `<img src>` for a sent attachment |
| `useRunningSessions()` | `{ runs, count }` | “N running” indicator |
| `useRuntimeCapabilities(id?)` | `RuntimeCapabilities` | Show only what a runtime supports |
| `useSpeechInput({ lang, onText })` | `{ supported, listening, start(), stop(), error }` | Dictation (Web Speech API) |
| `useConnection()` | `'connecting' \| 'live' \| 'reconnecting' \| 'offline'` | Event-stream connection state |
| `useUncageError()` | `{ error, dismiss }` | Error toast; every error has a `message` and a `hint` |
| `useUncageStore()` | the store | `actions.openDraft`, `actions.commitDraft`, … |

### A complete headless chat (Connected Mode)

Before the first prompt there is no session. Open a **draft** (`openDraft(runtimeId)`) so settings and files can be chosen, then `commitDraft()` creates the session on the selected computer, `select(id)` opens it, and `send(prompt)` starts the run.

```tsx title="headless-chat.tsx"
'use client';
import {
  isDraft,
  UncageProvider,
  useApprovalActions,
  useApprovals,
  useMachines,
  useMessages,
  useRun,
  useRuntimes,
  useSessions,
  useStoreSelector,
  useUncageError,
  useUncageStore,
} from '@uncage/react';
import { useEffect, useState, type FormEvent } from 'react';

function Connect() {
  const { install, loadInstallInfo } = useMachines({ watch: true }); // polls until a computer appears
  useEffect(() => {
    void loadInstallInfo();
  }, [loadInstallInfo]);
  if (!install) return <p>Loading…</p>;
  return (
    <section>
      <h2>Connect your computer</h2>
      <p>Run this command on your computer (macOS, Linux):</p>
      <pre>{install.install}</pre>
      {install.windows && <p>On Windows, in PowerShell:</p>}
      {install.windows && <pre>{install.windows}</pre>}
      <p>Already have the CLI? Run:</p>
      <pre>{install.setup}</pre>
      <p>Waiting for your computer…</p>
    </section>
  );
}

function Conversation() {
  const store = useUncageStore();
  const { current } = useMachines();
  const { runtimes } = useRuntimes();
  const { select } = useSessions();
  const { isActive, send, cancel } = useRun();
  const { timeline, messages, tools } = useMessages();
  const { all: approvals } = useApprovals();
  const { decide, pending } = useApprovalActions();
  const { error, dismiss } = useUncageError();
  const draft = useStoreSelector(isDraft);
  const [text, setText] = useState('');

  const claude = runtimes.find((r) => r.id === 'claude' && r.status === 'available');
  useEffect(() => {
    if (draft && claude) store.actions.openDraft(claude.id);
  }, [store, draft, claude]);

  const offline = current !== undefined && !current.online;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const prompt = text.trim();
    if (!prompt || isActive || offline) return;
    if (draft) await select(await store.actions.commitDraft());
    if (await send(prompt)) setText('');
  };

  return (
    <main>
      <header>{current ? `${current.name} (${current.online ? 'online' : 'offline'})` : 'No computer selected'}</header>
      {timeline.map((item) => {
        if (item.kind === 'message') {
          const m = messages[item.id];
          return m ? <p key={item.id} className={m.role}>{m.text}</p> : null;
        }
        if (item.kind === 'tools') {
          return (
            <ul key={item.runId}>
              {item.toolIds.map((id) => (
                <li key={id}>{tools[id] ? `${tools[id].title}: ${tools[id].status}` : null}</li>
              ))}
            </ul>
          );
        }
        const a = approvals.find((x) => x.id === item.id);
        if (!a) return null;
        return (
          <div key={a.id} role="group" aria-label={a.title}>
            <strong>{a.title}</strong> {a.target.command !== undefined && <code>{a.target.command}</code>}
            {a.state === 'pending' ? (
              <>
                <button type="button" disabled={pending[a.id] !== undefined} onClick={() => void decide(a.id, 'allow')}>
                  Allow
                </button>
                <button type="button" disabled={pending[a.id] !== undefined} onClick={() => void decide(a.id, 'deny')}>
                  Deny
                </button>
              </>
            ) : (
              <em> {a.state}</em>
            )}
          </div>
        );
      })}
      {error && (
        <p role="alert" onClick={dismiss}>
          {error.message} {error.hint}
        </p>
      )}
      <form onSubmit={(e) => void submit(e)}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} disabled={offline} />
        {isActive ? (
          <button type="button" onClick={() => void cancel()}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={offline}>
            Send
          </button>
        )}
      </form>
    </main>
  );
}

function App() {
  const { mode, machines, loading } = useMachines();
  if (loading && mode === 'unknown') return <p>Loading…</p>;
  if (mode === 'connected' && machines.length === 0) return <Connect />;
  return <Conversation />;
}

export function HeadlessChat() {
  return (
    <UncageProvider>
      <App />
    </UncageProvider>
  );
}
```

[`examples/react-headless-chat`](https://github.com/ptmafia/uncage/tree/main/examples/react-headless-chat) is a fuller headless chat (settings pickers, attachments, reload-safe URL) built only from these hooks, for Local Mode.

## Lower levels

- **`@uncage/client`**: the browser transport without React: REST calls plus a resumable SSE subscription (`createUncageClient({ baseUrl })`). About 5 KB minified.
- **The HTTP API** itself: see [HTTP API](/docs/reference/http-api/). Types are in `@uncage/protocol`.

## Wording

Use the same words as the built-in UI so users are not confused: the user’s machine is a **computer** (电脑), the background process on it is **the agent** (守护进程), and the website is **the site** (网站).
