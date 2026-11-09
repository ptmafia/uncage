---
title: 用 hooks 自定义界面
description: 定制 AgentChat（语言、主题、组件、CSS 变量），或基于无界面的 @uncage/react hooks 构建你自己的对话界面和“连接你的电脑”流程，Connected 模式和 Local 模式均适用。
---

你可以按需选用以下三个层次中的任意一层：

1. 原样使用 **`<AgentChat>`**（`@uncage/react-ui`），调整样式，替换部分组件。
2. 在你自己的布局里使用 `@uncage/react-ui` 的**各个组件**（`<ConnectMachine>`、`<MachineStatus>`、`<ApproveDevice>`、`<ApprovalCard>`、`<Composer>`……）。
3. **无界面 hooks**（`@uncage/react`）：在同一个 store 之上写你自己的组件。

三者在两种模式下都能用。store 通过向服务器请求 `/machines` 判断当前模式：hub 会响应（Connected 模式），本地的 Uncage 服务返回 404（Local 模式）。

## 1. 定制 `<AgentChat>`

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

| 属性 | 默认值 | |
| --- | --- | --- |
| `locale` | `'en'` | `'en'` 或 `'zh-CN'` |
| `theme` | `'auto'` | `'light'`、`'dark'` 或 `'auto'`（跟随操作系统） |
| `sidebar` | `true` | 会话列表 |
| `defaultRuntime` | 第一个可用的运行时 | 新会话使用的运行时 id，例如 `'claude'` |
| `starterPrompts` | 无 | 空状态上的按钮 |
| `showTools` | `true` | 消息之间的工具步骤 |
| `persistSession` | `'url'` | 刷新后重新打开会话：`?session=<id>`、`'localStorage'` 或 `false` |
| `components` | | 替换 `UserMessage`、`AssistantMessage`、`ToolSteps`、`ApprovalCard`、`Composer`、`EmptyState` |
| `className` | | 加在根元素上 |

用 `--uncage-*` CSS 变量调整样式；所有 class 都带 `uc-` 前缀。`UncageProvider` 的 `baseUrl` 默认为 `/api/uncage`；如果你把 hub（或 Local 模式的代理）挂在别处，请设置它。

在 Connected 模式下，`<AgentChat>` 还会：

- 用户还没有电脑时，把 `<ConnectMachine variant="inline">` 显示为空状态；
- 在标题栏显示当前对话所在的电脑（`<MachineStatus>`），带选择器和“连接另一台电脑…”；
- 那台电脑离线时禁用输入框（“你的电脑离线了，等待重新连接…”）。

## 2. 使用各个组件

`<ConnectMachine>` 就是独立的“连接你的电脑”流程：放在“macOS / Linux”和“Windows”标签页里的那一条安装命令（默认打开访问者操作系统对应的标签页）、给已经装好 CLI 的电脑的 `uncage setup <url>`、复制按钮、实时的“等待你的电脑上线…” → “已连接：&lt;名称&gt;”（显示期间每 3 秒轮询一次），以及给打不开浏览器的电脑的帮助。可以把它放在设置页、引导步骤或对话框里：

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

`variant="dialog"`（默认）是一个模态框，支持取消按钮、Esc 和点击背景关闭；`variant="inline"` 则嵌入页面。`<MachineStatus onSelect>` 是标题栏里的电脑菜单。`<ApproveDevice>` 是 `/device` 页面（[指南](/docs/zh-cn/guides/auth-and-device-approval/)）。它们都必须放在 `UncageProvider` 里面，只负责展示的 `<ApproveDevice>` 除外。

## 3. 无界面 hooks

用 `<UncageProvider>`（来自 `@uncage/react` 或 `@uncage/react-ui`）包裹你的应用，然后使用这些 hooks：

| Hook | 返回 | 用途 |
| --- | --- | --- |
| `useMachines({ watch? })` | `{ mode, connected, machines, selected, current, currentId, loading, error, install, select(id), refresh(), revoke(id), loadInstallInfo() }` | Connected 模式：用户的电脑、新会话使用哪台（`selected`）、当前会话运行在哪台（`current`）、安装命令。`watch: true` 会在页面可见时每 3 秒轮询一次。 |
| `useRuntimes()` | `{ runtimes, loading }` | 运行时选择器：`status` 为 `available`、`not_installed`、`auth_required`……，附带 `hint` 和 `installUrl` |
| `useSessions()` | `{ sessions, activeSessionId, loading, select(id), create(body), reload() }` | 会话列表、新建对话 |
| `usePersistSession(mode = 'url')` | `void` | 刷新后重新打开上一个会话 |
| `useSession()` | `{ session, connection, replayIncomplete }` | 标题栏、连接状态横幅。Connected 模式下有 `session.machineId` |
| `useRun()` | `{ run, isActive, send(prompt), cancel() }` | 输入框和停止按钮。运行被接受后 `send` 解析为 `true` |
| `useMessages()` | `{ timeline, messages, tools }` | 按顺序排列的对话 |
| `useApprovals()` | `{ pending, all }` | 审批卡片 |
| `useApprovalActions()` | `{ decide(id, 'allow' \| 'deny'), pending }` | 允许和拒绝，带每张卡片的提交中状态 |
| `useSessionSettings()` | `{ settings, capabilities, update(patch), pendingForNextRun }` | 模型、推理强度和权限模式选择器 |
| `useAttachments()` | `{ items, add(files), remove(localId), clear(), ready, rejected }` | 附件按钮和附件标签 |
| `useAttachmentUrl(id)` | `string` | 已发送附件的 `<img src>` |
| `useRunningSessions()` | `{ runs, count }` | “N 个运行中”指示器 |
| `useRuntimeCapabilities(id?)` | `RuntimeCapabilities` | 只显示运行时支持的功能 |
| `useSpeechInput({ lang, onText })` | `{ supported, listening, start(), stop(), error }` | 语音输入（Web Speech API） |
| `useConnection()` | `'connecting' \| 'live' \| 'reconnecting' \| 'offline'` | 事件流的连接状态 |
| `useUncageError()` | `{ error, dismiss }` | 错误提示；每个错误都有 `message` 和 `hint` |
| `useUncageStore()` | store 本身 | `actions.openDraft`、`actions.commitDraft`…… |

### 一个完整的无界面对话（Connected 模式）

发出第一条提示词之前还没有会话。先打开一个**草稿**（`openDraft(runtimeId)`），以便选择设置和文件；然后 `commitDraft()` 在选中的电脑上创建会话，`select(id)` 打开它，`send(prompt)` 开始运行。

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

[`examples/react-headless-chat`](https://github.com/ptmafia/uncage/tree/main/examples/react-headless-chat) 是一个更完整的无界面对话（设置选择器、附件、刷新不丢的 URL），只用这些 hooks 构建，面向 Local 模式。

## 更底层

- **`@uncage/client`**：不依赖 React 的浏览器传输层：REST 调用加上可续传的 SSE 订阅（`createUncageClient({ baseUrl })`）。压缩后约 5 KB。
- **HTTP API** 本身：见 [HTTP API](/docs/zh-cn/reference/http-api/)。类型在 `@uncage/protocol` 里。

## 用词

使用和内置界面相同的词，以免让用户困惑：用户的机器叫**电脑**（computer），上面的后台进程叫**守护进程**（the agent），网站叫**网站**（the site）。
