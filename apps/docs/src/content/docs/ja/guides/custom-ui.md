---
title: フックで UI をカスタマイズする
description: AgentChat をカスタマイズする（ロケール、テーマ、コンポーネント、CSS 変数）か、ヘッドレスな @uncage/react のフックから独自のチャットとコンピュータ接続のフローを構築します。Connected モードと Local モードの両方に対応します。
---

カスタマイズは 3 つの段階のどこで止めてもかまいません。

1. **`<AgentChat>`**（`@uncage/react-ui`）をそのまま使い、スタイルを変えたり一部を差し替えたりする。
2. `@uncage/react-ui` の**部品**（`<ConnectMachine>`、`<MachineStatus>`、`<ApproveDevice>`、`<ApprovalCard>`、`<Composer>` など）を独自のレイアウトに配置する。
3. **ヘッドレスなフック**（`@uncage/react`）を使い、同じストアの上に独自のコンポーネントを作る。

どれも両方のモードで動作します。ストアはサーバーに `/machines` を問い合わせて、どちらのモードかを判断します。ハブが応答すれば Connected モード、ローカルのデーモンが 404 を返せば Local モードです。

## 1. `<AgentChat>` をカスタマイズする

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

| プロップ | デフォルト | |
| --- | --- | --- |
| `locale` | `'en'` | `'en'` または `'zh-CN'` |
| `theme` | `'auto'` | `'light'`、`'dark'`、`'auto'`（OS の設定に従う） |
| `sidebar` | `true` | セッション一覧 |
| `defaultRuntime` | 最初に利用可能なもの | 新しいセッションのランタイム ID。例：`'claude'` |
| `starterPrompts` | なし | 空の状態に表示するボタン |
| `showTools` | `true` | メッセージ間のツールのステップ |
| `persistSession` | `'url'` | リロード後にセッションを開き直す方法：`?session=<id>`、`'localStorage'`、または `false` |
| `components` | | `UserMessage`、`AssistantMessage`、`ToolSteps`、`ApprovalCard`、`Composer`、`EmptyState` を差し替えます |
| `className` | | ルート要素に付与されます |

スタイルは `--uncage-*` の CSS 変数で変更します。すべてのクラスには `uc-` の接頭辞が付いています。`UncageProvider` の `baseUrl` のデフォルトは `/api/uncage` です。ハブ（または Local モードのプロキシ）を別の場所にマウントした場合は指定してください。

Connected モードでは、`<AgentChat>` はさらに次のように動作します。

- ユーザーがコンピュータを持っていない間は、空の状態として `<ConnectMachine variant="inline">` を表示します。
- 開いている会話のコンピュータをヘッダーに表示します（`<MachineStatus>`）。切り替え用のピッカーと “Connect another computer…”（別のコンピュータを接続）も備えています。
- そのコンピュータがオフラインの間は入力欄を無効にします（“Your computer is offline. Waiting for it to reconnect…”）。

## 2. 部品を使う

`<ConnectMachine>` は「コンピュータを接続する」フローを単独で提供します。インストールコマンド（macOS タブ。Windows は “coming soon”）、コピーボタン付きの `uncage setup <url>` コマンド、“Waiting for your computer…” から “Connected: &lt;name&gt;” に切り替わるライブ表示（表示中は 3 秒ごとにポーリングします）、ブラウザを開けないコンピュータ向けのヘルプが含まれます。設定ページ、オンボーディングのステップ、ダイアログなどに配置してください。

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

`variant="dialog"`（デフォルト）は、キャンセルボタン、Esc キー、背景クリックで閉じられるモーダルです。`variant="inline"` はページに埋め込みます。`<MachineStatus onSelect>` はヘッダーのコンピュータメニューです。`<ApproveDevice>` は `/device` ページです（[ガイド](/docs/ja/guides/auth-and-device-approval/)）。表示だけを担う `<ApproveDevice>` を除き、いずれも `UncageProvider` の内側に置く必要があります。

## 3. ヘッドレスなフック

アプリを `<UncageProvider>`（`@uncage/react` または `@uncage/react-ui` から）で包み、次のフックを使います。

| フック | 戻り値 | 用途 |
| --- | --- | --- |
| `useMachines({ watch? })` | `{ mode, connected, machines, selected, current, currentId, loading, error, install, select(id), refresh(), revoke(id), loadInstallInfo() }` | Connected モード：ユーザーのコンピュータ、新しいセッションが使うもの（`selected`）、開いているセッションが動いているもの（`current`）、インストールコマンド。`watch: true` を指定すると、ページが表示されている間 3 秒ごとにポーリングします。 |
| `useRuntimes()` | `{ runtimes, loading }` | ランタイムのピッカー。`status` は `available`、`not_installed`、`auth_required` などで、`hint` と `installUrl` が付きます |
| `useSessions()` | `{ sessions, activeSessionId, loading, select(id), create(body), reload() }` | セッション一覧、新しいチャット |
| `usePersistSession(mode = 'url')` | `void` | リロード時に最後のセッションを開き直す |
| `useSession()` | `{ session, connection, replayIncomplete }` | ヘッダー、接続状態のバナー。Connected モードでは `session.machineId` |
| `useRun()` | `{ run, isActive, send(prompt), cancel() }` | 入力欄と停止ボタン。`send` は実行が受け付けられると `true` で解決します |
| `useMessages()` | `{ timeline, messages, tools }` | 会話を順番どおりに |
| `useApprovals()` | `{ pending, all }` | 承認カード |
| `useApprovalActions()` | `{ decide(id, 'allow' \| 'deny'), pending }` | 許可と拒否。カードごとの処理中の状態付き |
| `useSessionSettings()` | `{ settings, capabilities, update(patch), pendingForNextRun }` | モデル、エフォート、パーミッションモードのピッカー |
| `useAttachments()` | `{ items, add(files), remove(localId), clear(), ready, rejected }` | 添付ボタンとチップ |
| `useAttachmentUrl(id)` | `string` | 送信済みの添付ファイル用の `<img src>` |
| `useRunningSessions()` | `{ runs, count }` | 「N 件実行中」のインジケーター |
| `useRuntimeCapabilities(id?)` | `RuntimeCapabilities` | ランタイムが対応している機能だけを表示する |
| `useSpeechInput({ lang, onText })` | `{ supported, listening, start(), stop(), error }` | 音声入力（Web Speech API） |
| `useConnection()` | `'connecting' \| 'live' \| 'reconnecting' \| 'offline'` | イベントストリームの接続状態 |
| `useUncageError()` | `{ error, dismiss }` | エラーのトースト。すべてのエラーに `message` と `hint` があります |
| `useUncageStore()` | ストア | `actions.openDraft`、`actions.commitDraft` など |

### ヘッドレスなチャットの完全な例（Connected モード）

最初のプロンプトを送るまで、セッションは存在しません。設定やファイルを選べるよう**下書き**を開き（`openDraft(runtimeId)`）、続いて `commitDraft()` で選択中のコンピュータにセッションを作成し、`select(id)` でそれを開き、`send(prompt)` で実行を開始します。

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
      <p>Run these two commands in Terminal on your Mac:</p>
      <pre>{install.install}</pre>
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

[`examples/react-headless-chat`](https://github.com/ptmafia/uncage/tree/main/examples/react-headless-chat) は、これらのフックだけで作った、より本格的なヘッドレスチャット（設定のピッカー、添付ファイル、リロードしても失われない URL）で、Local モード向けです。

## より低いレベル

- **`@uncage/client`**：React を使わないブラウザ用のトランスポートです。REST 呼び出しと、再開可能な SSE の購読を提供します（`createUncageClient({ baseUrl })`）。minify 後で約 5 KB です。
- **HTTP API** そのもの：[HTTP API](/docs/ja/reference/http-api/) を参照してください。型は `@uncage/protocol` にあります。

## 用語

ユーザーが混乱しないよう、組み込みの UI と同じ言葉を使ってください。ユーザーのマシンは**コンピュータ**（英語 UI では computer、中国語 UI では 电脑）、その上で動くバックグラウンドプロセスは**エージェント**（英語 UI では the agent、中国語 UI では 守护进程）、ウェブサイトは**サイト**（英語 UI では the site、中国語 UI では 网站）と呼びます。
