---
title: 'クイックスタート：Connected モード'
description: Next.jsアプリにUncageを追加し、サインインしたユーザーが自分のコンピュータを接続して、あなたのサイトから自分のClaude Codeを動かせるようにします。サイトツールも1つ用意します。所要時間は約15分です。
---

このページを終えると、次の状態になります：

- Next.jsアプリが`/api/uncage`でUncageのハブを提供している。
- あるページに`<AgentChat>`が表示され、最初に「Connect your computer」（コンピュータを接続）が案内される。
- ユーザーは`/device`で自分のコンピュータを承認する。
- ユーザーのコンピュータ上のClaude Codeが、あなたのツールの1つである`save_note`を呼び出せる。このツールはあなたのサーバーで、そのユーザーとして実行される。

このページでは、あなたが両方の立場を担当します。まずウェブサイトの開発者、次にコンピュータを接続するユーザーです。

## コーディングエージェント用のプロンプトをコピーする

Claude Code、Codex、その他のコーディングエージェントを使っている場合は、手順を手作業で進める代わりに、次のプロンプトを貼り付けてください：

```text wrap
Add Uncage Connected Mode to this Next.js (App Router) app, following https://uncage-dev.vercel.app/docs/start/quickstart-connected.md exactly.
Read https://uncage-dev.vercel.app/docs/skills/uncage/SKILL.md first and follow its rules.
1. Install @uncage/hub, @uncage/react-ui and zod.
2. Create lib/auth.ts, lib/tools.ts, lib/uncage-hub.ts, lib/hub-registry.ts, server.ts, app/uncage/page.tsx, app/device/page.tsx, app/device/actions.ts, app/device/approve-page.tsx and the headers in next.config.ts, as on that page.
3. Wire lib/auth.ts to this app's existing sign-in (find how the app reads the current user). Do not keep the development user unless the app has no sign-in at all.
4. Change the "dev" and "start" scripts to run server.ts with node (Node.js 22.18 or newer), set "type": "module" in package.json and "allowImportingTsExtensions": true in tsconfig.json.
5. Add .uncage-hub/ to .gitignore.
Verify: start the dev server, then curl -s http://localhost:3000/api/uncage/install.sh | head -3 prints the installer, and curl -sI http://localhost:3000/device shows the headers Content-Security-Policy: frame-ancestors 'none' and X-Frame-Options: DENY (no ?code=: unknown codes count as failed guesses and are rate limited). Report what you changed and anything you could not wire.
```

## 始める前に

- **ウェブサイト側**：Nodeで動かすNext.js 16アプリ（App Router）。Node.jsは**22.18以降**が必要です。後述のカスタムサーバーは、Nodeが直接実行する`.ts`ファイルだからです。新規に始める場合：`npx create-next-app@latest my-site`（TypeScript、App Router）。
- **ユーザー側（このテストではあなた自身のコンピュータ）**：Node.js 22以降（後述のインストーラーで用意できます）と、インストール済みでサインインしたClaude Code：`npm i -g @anthropic-ai/claude-code`を実行し、`claude`を一度起動して`/login`と入力します。OSはmacOS、Linux、Windowsのいずれか（macOSは実機で検証済み、LinuxとWindowsはCIで検証済みで、実機での確認を待っている段階です）。

:::note[カスタムサーバーを使う理由]
このクイックスタートでは**従来モード（常駐プロセス）**を使います。ハブは接続中のすべてのコンピュータとWebSocketを開いたままにし、データを組み込みデータベースのフォルダに保存するため、他に何も用意する必要がありません。そのためには、HTTPサーバーにアクセスできる常駐のNodeプロセスが必要ですが、Next.jsのルートハンドラーだけではそれが得られません。代わりに**Vercel**などのサーバーレスプラットフォームにデプロイする場合は、[VercelでNext.js](/docs/ja/deploy/vercel/)を参照してください（ルートハンドラーとPostgresを使い、カスタムサーバーは不要です）。どちらを選ぶべきかは、[デプロイモードを選ぶ](/docs/ja/start/choose-deployment-mode/)で説明しています。
:::

## 1. インストールする

```sh
npm i @uncage/hub @uncage/react-ui zod
```

## 2. サインイン中のユーザーを返す

ハブはブラウザからのリクエストのたびに、ユーザーが誰なのかをアプリに問い合わせます。このクイックスタートでは固定の開発用ユーザーを使います。実際のサインインを接続する方法は[認証ガイド](/docs/ja/guides/auth-and-device-approval/)で説明しています。

```ts title="lib/auth.ts"
import type { HubUser } from '@uncage/hub';

/**
 * Replace both functions with your real sign-in before you deploy.
 * `userFromRequest` is used by the hub (a Fetch `Request`); `currentUser` by your pages.
 */
export async function userFromRequest(_req: Request): Promise<HubUser | null> {
  return developmentUser();
}

export async function currentUser(): Promise<HubUser | null> {
  return developmentUser();
}

function developmentUser(): HubUser {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('lib/auth.ts still returns the development user: connect it to your sign-in.');
  }
  return { id: 'dev-user', name: 'Developer' };
}
```

## 3. ツールを定義する

サイトツールは、Claude Codeが呼び出せる、あなたのウェブサイトの機能です。ハンドラーは**あなたのサーバーで**、セッションを所有するユーザーとして実行されます。ユーザーのコンピュータが受け取るのは、名前、説明、`input`から生成されたJSON Schemaだけです。

```ts title="lib/tools.ts"
import { defineTool, type SiteTool } from '@uncage/hub';
import { z } from 'zod';

/** Stand-in for your database. */
// Kept on globalThis: server.ts and Next.js pages load separate copies of this module,
// so a plain module-level Map would look empty from a page that lists the notes.
type Notes = Map<string, Array<{ id: string; title: string; text: string }>>;
const g = globalThis as typeof globalThis & { __demoNotes?: Notes };
const notes: Notes = (g.__demoNotes ??= new Map());

export const saveNote = defineTool({
  name: 'save_note',
  description: 'Save a note to the signed-in user’s notes on the website. Returns the note id.',
  input: z.object({
    title: z.string().min(1).max(120),
    text: z.string().min(1).max(10_000),
  }),
  handler: async ({ title, text }, ctx) => {
    const mine = notes.get(ctx.user.id) ?? [];
    const note = { id: `note_${mine.length + 1}`, title, text };
    notes.set(ctx.user.id, [...mine, note]);
    return { saved: note.id };
  },
});

export const tools: SiteTool[] = [saveNote];
```

## 4. ハブを作成する

ハブはカスタムサーバーが一度だけ作成します。ページ側でもハブが必要ですが（承認ページが呼び出します）、Next.jsはページのコードを別にバンドルするため、サーバーは`globalThis`を通じてインスタンスを受け渡します。

```ts title="lib/uncage-hub.ts"
import { createHub, type Hub } from '@uncage/hub';
import { pgliteHubStore } from '@uncage/hub/node';
import { userFromRequest } from './auth.ts';
import { tools } from './tools.ts';

export async function createAppHub(): Promise<Hub> {
  return createHub({
    // The URL your users open. Also what `uncage setup <url>` is given.
    publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
    getUser: userFromRequest,
    // The hub's own database: embedded Postgres in this folder (computers, sessions, tool calls).
    store: await pgliteHubStore({ dataDir: './.uncage-hub' }),
    tools,
    // Keep a copy of every conversation on the website (readable while the computer is off).
    sessionStorage: 'site',
  });
}
```

```ts title="lib/hub-registry.ts"
import type { Hub } from '@uncage/hub';

const KEY = Symbol.for('my-site.uncage-hub');

/** Called once by server.ts. */
export function publishHub(hub: Hub): void {
  (globalThis as Record<symbol, unknown>)[KEY] = hub;
}

/** The hub server.ts created, for pages and Server Actions. */
export function getHub(): Hub {
  const hub = (globalThis as Record<symbol, unknown>)[KEY] as Hub | undefined;
  if (!hub) throw new Error('The Uncage hub is not running: start the app with `node server.ts`, not `next dev`.');
  return hub;
}
```

`pgliteHubStore`は、ハブのデータを`./.uncage-hub`（組み込みのPGlite。1つのフォルダにつきプロセスは1つ）に保存します。このフォルダを`.gitignore`に追加し、デプロイ時には永続ディスク上に置いてください。

## 5. カスタムサーバー

1つのNode HTTPサーバーがすべてを担います。`/api/uncage`配下のハブのHTTP API、`/api/uncage/agent`でのコンピュータとのWebSocket、それ以外のすべてのパスに対するNext.jsアプリです。`toNodeHandler`と`attachWebSocket`は、ハブのNode専用部分である`@uncage/hub/node`から読み込みます。

```ts title="server.ts"
import { createServer } from 'node:http';
import { attachWebSocket, toNodeHandler } from '@uncage/hub/node';
import next from 'next';
import { publishHub } from './lib/hub-registry.ts';
import { createAppHub } from './lib/uncage-hub.ts';

const dev = process.env.NODE_ENV !== 'production';
// If you change PORT, also set PUBLIC_URL (lib/uncage-hub.ts) to the URL users open.
const port = Number(process.env.PORT ?? 3000);

const hub = await createAppHub();
publishHub(hub);
const hubHandler = toNodeHandler(hub);

const server = createServer();
const app = next({ dev, hostname: 'localhost', port, httpServer: server });
const handle = app.getRequestHandler();
await app.prepare();

server.on('request', (req, res) => {
  // Paths under /api/uncage go to the hub; everything else falls through to Next.js.
  hubHandler(req, res, () => void handle(req, res));
});

attachWebSocket(hub, server); // computers connect to ws(s)://<host>/api/uncage/agent

if (dev) {
  // Next.js hot reload uses WebSockets too; leave the hub's path to the hub.
  const upgrade = app.getUpgradeHandler();
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== `${hub.basePath}/agent`) void upgrade(req, socket, head);
  });
}

server.listen(port, () => console.log(`ready on http://localhost:${port}`));
```

`next dev`ではなくNodeで起動します。Nodeは`server.ts`を直接実行し（型は取り除かれます）、そこからインポートするファイルには明示的に`.ts`拡張子を付けているので、次のように設定します：

```json title="package.json (excerpt)"
{
  "type": "module",
  "scripts": {
    "dev": "node server.ts",
    "build": "next build",
    "start": "NODE_ENV=production node server.ts"
  }
}
```

```json title="tsconfig.json (excerpt)"
{
  "compilerOptions": {
    "allowImportingTsExtensions": true
  }
}
```

## 6. チャットページ

`<AgentChat>`はデフォルトで`/api/uncage`と通信します。接続先がハブ（ローカルデーモンではない）であることを検出すると、自動的にConnected モードに切り替わります。まだコンピュータがなければインストールコマンドを1つ示す`<ConnectMachine>`を表示し、接続後はヘッダーに会話を実行しているコンピュータが表示されます。

```tsx title="app/uncage/page.tsx"
'use client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

export default function UncagePage() {
  return (
    <div style={{ height: '100vh' }}>
      <UncageProvider>
        <AgentChat starterPrompts={['Write a short poem about this website and save it with save_note']} />
      </UncageProvider>
    </div>
  );
}
```

## 7. 承認ページ

`uncage setup`はユーザーをあなたのサイトの`/device?code=…`へ誘導します。そこで承認すると、そのコンピュータがユーザーのアカウントにアクセスできるようになります。そのため、このページはサインイン中のユーザーにだけ提供し、フレーム内に埋め込めないようにし、判断は自分のオリジンからしか送れないPOSTで記録する必要があります。Next.jsのServer ActionsはPOST専用で`Origin`を検証するため、最後の点はこれで満たせます。

```tsx title="app/device/page.tsx"
import type { ApproveDeviceProps } from '@uncage/react-ui';
import { currentUser } from '../../lib/auth.ts';
import { getHub } from '../../lib/hub-registry.ts';
import { ApprovePage } from './approve-page.tsx';

export const dynamic = 'force-dynamic';

type DeviceError = NonNullable<ApproveDeviceProps['error']>;

export default async function DevicePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code = '' } = await searchParams;
  const user = await currentUser();
  if (!user) return <p>Sign in first, then open this link again.</p>; // or redirect to your login page
  let lookup: ApproveDeviceProps['lookup'] = null;
  let error: DeviceError | undefined;
  try {
    lookup = code ? await getHub().lookupDevice(code, user) : null;
  } catch (e) {
    // Unknown codes count as failed guesses; after 10 in 10 minutes lookupDevice throws `rate_limited`.
    // <ApproveDevice> shows the error, localized, in place of "code not found".
    const err = e as { code?: string; message?: string };
    error = { code: err.code === 'rate_limited' ? 'rate_limited' : 'internal_error', message: err.message ?? 'Could not check this code.' };
  }
  return <ApprovePage code={code} lookup={lookup} initialError={error} />;
}
```

```ts title="app/device/actions.ts"
'use server';
import { currentUser } from '../../lib/auth.ts';
import { getHub } from '../../lib/hub-registry.ts';

export type DecideResult = { result: 'ok' | 'not_found' | 'expired' } | { error: { code: string; message: string } };

/** A Server Action: a POST that Next.js only accepts from this site's own Origin. */
export async function decide(code: string, approve: boolean): Promise<DecideResult> {
  const user = await currentUser();
  if (!user) return { error: { code: 'unauthorized', message: 'Sign in again.' } };
  try {
    const hub = getHub();
    return { result: await (approve ? hub.approveDevice(code, user) : hub.denyDevice(code, user)) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { error: { code: err.code ?? 'internal_error', message: err.message ?? 'Failed' } };
  }
}
```

```tsx title="app/device/approve-page.tsx"
'use client';
import { ApproveDevice, type ApproveDeviceProps, type ApproveDeviceState } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';
import { useState } from 'react';
import { decide } from './actions.ts';

export function ApprovePage({
  code,
  lookup,
  initialError,
}: Pick<ApproveDeviceProps, 'code' | 'lookup'> & { initialError?: ApproveDeviceProps['error'] }) {
  const [state, setState] = useState<ApproveDeviceState>('idle');
  const [error, setError] = useState<ApproveDeviceProps['error']>(initialError);
  const act = async (approve: boolean) => {
    setState(approve ? 'approving' : 'denying');
    setError(undefined);
    const r = await decide(code, approve);
    if ('error' in r) {
      setState('idle'); // the buttons stay enabled for a retry
      setError(r.error as ApproveDeviceProps['error']);
    } else {
      setState(r.result === 'ok' ? (approve ? 'approved' : 'denied') : r.result);
    }
  };
  return <ApproveDevice code={code} lookup={lookup} state={state} error={error} onApprove={() => void act(true)} onDeny={() => void act(false)} />;
}
```

承認ページで（いちばん簡単なのはすべてのページで）フレームへの埋め込みを拒否します：

:::caution[ファイル全体を置き換える]
最近の`create-next-app`テンプレートは`next.config.ts`に`cacheComponents: true`を追加します。これは`/device`ページの`export const dynamic = 'force-dynamic'`と競合します（`next build`が「Route segment config "dynamic" is not compatible with `nextConfig.cacheComponents`」で失敗します）。生成されたファイルにマージするのではなく、次のファイルで置き換えてください。
:::

```ts title="next.config.ts"
import type { NextConfig } from 'next';

const config: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
```

## 8. ウェブサイトを起動する

```sh
npm run dev
```

ハブが応答することを確認します：

```sh
curl -s http://localhost:3000/api/uncage/install.sh | head -3
```

インストーラーの冒頭（`#!/usr/bin/env bash`、`# Uncage installer: …`）が出力されます。

## 9. コンピュータを接続する（ユーザー側）

`http://localhost:3000/uncage`を開きます。チャットに**Connect your computer**（コンピュータを接続）とコマンドが1つ、あなたのOSのタブで表示されます。本番環境ではユーザーがこれをコピーします。このローカルテストでは次のようにします：

1. **コマンドを実行します**。macOSまたはLinuxでは`curl -fsSL http://localhost:3000/api/uncage/install.sh | bash`、Windows（PowerShell）では`irm http://localhost:3000/api/uncage/install.ps1 | iex`を実行します。インストーラーはまずコンピュータの状態（Node.js 22以降、npm、コーディングエージェント）を確認し、必要な手順ごとに`[Y/n]`で確認を求め（Nodeのバージョンマネージャーがあればそれを使い、`sudo`や管理者権限は一切使いません）、`@uncage/cli`をインストールして、`uncage setup http://localhost:3000`を代わりに実行するかどうかを尋ねます。**Y**と答えてください。OSごとの動作は[コンピュータへのインストール](/docs/ja/start/install-on-your-computer/)を参照してください。
2. **すでにCLIがある**（`npm i -g @uncage/cli`）場合は、代わりにページの**Already have the CLI?**（CLIはインストール済み？）の下に表示されるsetupコマンドを実行します。

   ```sh
   uncage setup http://localhost:3000
   ```

3. **承認します**。setupはコードを表示し、`http://localhost:3000/device?code=…`を開きます。コードが一致していることを確認し、**Approve**（承認）をクリックします。setupはマシントークンを`~/.uncage/agent.yaml`に保存し、バックグラウンドのエージェント（ユーザー単位のサービス。macOSではlaunchd、Linuxではsystemd、Windowsではタスク スケジューラのタスク。`uncage agent status`で確認できます）を起動します。

チャットページに戻ると、ステータスが「Waiting for your computer…」（コンピュータを待機中）から**Connected: &lt;コンピュータ名&gt;**（接続済み）に変わります。

:::tip[プレーンなhttp]
エージェントが`http://`を受け付けるのは`localhost`と`127.0.0.1`の場合だけです。それ以外のウェブサイトはすべて`https://`を使う必要があります（このときWebSocketは`wss://`を使います）。
:::

## 10. タスクを送る

スタータープロンプトをクリックするか、「Write a short poem about this website and save it with save_note」（このウェブサイトについての短い詩を書いて、save_noteで保存して）と入力します。

- Claude Codeはあなたのコンピュータの`~/Uncage/localhost-3000/<session id>/`で実行されます。
- Claude Codeが`mcp__site__save_note`を呼び出します。ハンドラーはNext.jsサーバーで`dev-user`として実行されます。
- 回答はチャットにストリーミングされます。コマンドとファイル編集には、**Allow once**（許可）/ **Deny**（拒否）の承認カードが表示されます。

エージェントを停止して（`uncage agent uninstall`、またはフォアグラウンドで動かしている場合は`uncage agent`を終了）、ページをリロードしてみてください。`sessionStorage: 'site'`のおかげで会話は残っており（URLに`?session=…`が保持され、サイドバーにも表示されます）、コンポーザーにはコンピュータがオフラインであることが表示されます。

## 作ったもの

| ファイル | 役割 |
| --- | --- |
| `lib/auth.ts` | サインイン中のユーザー（実際の認証に置き換えます） |
| `lib/tools.ts` | サイトツール |
| `lib/uncage-hub.ts`、`lib/hub-registry.ts` | ハブの作成と、ページとの共有 |
| `server.ts` | 1つのHTTPサーバー：ハブのAPI、コンピュータとのWebSocket、Next.js |
| `app/uncage/page.tsx` | チャット |
| `app/device/*`、`next.config.ts` | 安全な承認ページ |

リポジトリの[`examples/connected-demo`](https://github.com/ptmafia/uncage/tree/main/examples/connected-demo)は、同じ構成を本格的なサイトに発展させたものです。サインイン、ランディングページを作成・公開する2つのツール（ユーザーのコンピュータからファイルを取得します）、スキル、アセットギャラリー、RedisとPostgresを使う2ノード構成を備えています。実際のClaude Codeを相手にエンドツーエンドでテストされています。

## 次のステップ

- [ツールを定義する](/docs/ja/guides/define-tools/)：バリデーション、エラー、確認、ファイルチャネル。
- [スキルを書く](/docs/ja/guides/write-skills/)、[実行ごとに選ぶ](/docs/ja/guides/select-manifest/)。
- [認証とデバイスの承認](/docs/ja/guides/auth-and-device-approval/)：実際のサインインを接続します。
- [デプロイ](/docs/ja/deploy/node/)：サーバーに載せる（従来モード）か、[Vercel](/docs/ja/deploy/vercel/)に移行します（FaaS モード）。
- [マルチノード](/docs/ja/guides/multi-node/)：ロードバランサーの背後でPostgres + Redisを使います。
- **プロキシの背後にデプロイする前に**：クライアントIPを設定してください（`trust proxy`または`rateLimits.clientIp`）。設定しないと、すべてのユーザーが`uncage setup`のレート制限を1つの枠で共有することになります。[プロキシの背後で](/docs/ja/guides/mount-the-hub/#リバースプロキシやロードバランサーの背後で)を参照してください。
