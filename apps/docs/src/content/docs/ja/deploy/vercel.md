---
title: VercelでNext.js（FaaS モード）
description: Postgresだけを使い、VercelのNext.js App Routerのルートハンドラーでハブを動かす方法を説明します。waitUntilにafterを渡すtoNextHandlers、maxDuration、メンテナンス用のcron、Neonとプール接続のURLについて、完全なファイル、環境変数、デプロイ手順、確認チェックリスト、FAQとともに解説します。
---

Vercelでは、ハブはNext.jsの**ルートハンドラー**の中で動きます。カスタムサーバーも、WebSocketも、別のサービスも不要です。関数インスタンスのそれぞれがハブとして動き、1つのPostgresデータベースを共有します。ユーザーのコンピュータは**HTTPストリーミング**で接続します（これは長時間のリクエストで、ハブがVercelの制限時間より前に終了させ、エージェントがすぐに開き直します）。同じファイルは、どこでも`next start`で動かせます。FaaS モードを選ぶ理由とそのコストについては、[デプロイモードを選ぶ](/docs/ja/start/choose-deployment-mode/)を参照してください。

## 前提条件

- Vercel上の、App Routerを使う**Next.js 15.1以降**のアプリ（以下のファイルは`next/server`の`after`を使います）。
- Vercelから接続できる**Postgres**データベース：Neon、Supabase、VercelのPostgresインテグレーション、または自前のもの。その接続文字列が`DATABASE_URL`になります。プール接続のURL（Neonの`-pooler`ホスト、PgBouncer）も使えます。むしろこちらを推奨します。
- `Request`（ハブ用）と`cookies()`（ページ用）から読み取れるアプリのサインイン情報。

```sh
npm i @uncage/hub @uncage/react-ui pg zod
npm i -D @types/pg
```

## コード

ファイルは7つです。パスはプロジェクトのルートからの相対パスです。

### サインイン中のユーザー

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

### ハブ

関数インスタンスごとにハブを1つ作ります。最初のリクエストで作成するため、`next build`がデータベースに接続することはありません。ルートハンドラーとページで共有します。

```ts title="lib/uncage-hub.ts"
import { createHub, postgresCluster, postgresHubStore, type Hub } from '@uncage/hub';
import pg from 'pg';
import { userFromRequest } from './auth.ts';

async function createAppHub(): Promise<Hub> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set: add your Postgres connection string to the project’s environment variables.');
  const publicUrl = process.env.PUBLIC_URL ?? (process.env.VERCEL ? undefined : 'http://localhost:3000');
  if (!publicUrl) throw new Error('PUBLIC_URL is not set: add your site’s https:// origin to the project’s environment variables.');
  // One small pool per function instance, shared by the store and the cluster.
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  pool.on('error', (err) => console.error('postgres pool error:', err.message)); // required for your own pool
  const store = await postgresHubStore({ pool });
  return createHub({
    publicUrl, // what users open; localhost only outside Vercel
    getUser: userFromRequest,
    store,
    cluster: postgresCluster({ pool }), // wake-ups between function instances, through Postgres
    sessionStorage: 'site',
    // End long responses (agent streams, browser events) before the route's maxDuration (300 s).
    stream: { maxDurationMs: 250_000 },
    // A site tool runs inside one request: keep its limit well inside maxDuration.
    toolTimeoutMs: 120_000,
    // Enables GET /api/uncage/maintenance for Vercel Cron (it sends Authorization: Bearer $CRON_SECRET).
    ...(process.env.CRON_SECRET ? { maintenance: { secret: process.env.CRON_SECRET } } : {}),
  });
}

const KEY = Symbol.for('my-site.uncage-hub');
type Holder = { [KEY]?: Promise<Hub> };

/** The hub of this function instance. A failed start (database briefly down) is retried on the next call. */
export function getHub(): Promise<Hub> {
  const g = globalThis as Holder;
  const hub = (g[KEY] ??= createAppHub());
  hub.catch(() => {
    if (g[KEY] === hub) delete g[KEY];
  });
  return hub;
}
```

### ルートハンドラー

```ts title="app/api/uncage/[...path]/route.ts"
import { toNextHandlers } from '@uncage/hub';
import { after } from 'next/server';
import { getHub } from '../../../../lib/uncage-hub.ts';

// `after`: the hub's background work (maintenance) never delays a response.
export const { GET, POST, PATCH, DELETE } = toNextHandlers(getHub, { waitUntil: after });

/** Seconds a request may run on Vercel. The hub ends its streams earlier (stream.maxDurationMs). */
export const maxDuration = 300;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
```

`toNextHandlers`は、各リクエストを次の情報とともに`hub.fetch`に渡します。

- **クライアントIP**：IPごとのレート制限に使います。Vercel上（`VERCEL`環境変数が設定されている場合）では、Vercelのエッジが`x-real-ip`に設定するアドレスを使います。Vercelではクライアントがこの値を偽装することはできません。それ以外の環境では、`clientIp: (req) => …`を自分で渡してください。
- **`waitUntil`**：Next.jsの`after`です。これにより、メンテナンスはレスポンスの後に実行され、エージェントのリクエストが切れてもサイトツールの呼び出しは最後まで完了します。

### チャットページ

```tsx title="app/uncage/page.tsx"
'use client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

export default function UncagePage() {
  return (
    <div style={{ height: '100vh' }}>
      <UncageProvider>
        <AgentChat />
      </UncageProvider>
    </div>
  );
}
```

### 承認ページ

`uncage setup`が、コンピュータを承認させるためにユーザーを誘導するページです。サインイン中のユーザーだけが使え、フレーム内には表示されず、承認・拒否はServer Action（Next.jsが自サイトのオリジンからしか受け付けないPOST）で処理します。[クイックスタート](/docs/ja/start/quickstart-connected/#7-承認ページ)と同じファイルで、`await getHub()`を使う点だけが異なります。

```tsx title="app/device/page.tsx"
import type { ApproveDeviceProps } from '@uncage/react-ui';
import { currentUser } from '../../lib/auth.ts';
import { getHub } from '../../lib/uncage-hub.ts';
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
    lookup = code ? await (await getHub()).lookupDevice(code, user) : null;
  } catch (e) {
    // Unknown codes count as failed guesses; after 10 in 10 minutes lookupDevice throws `rate_limited`.
    const err = e as { code?: string; message?: string };
    error = { code: err.code === 'rate_limited' ? 'rate_limited' : 'internal_error', message: err.message ?? 'Could not check this code.' };
  }
  return <ApprovePage code={code} lookup={lookup} initialError={error} />;
}
```

```ts title="app/device/actions.ts"
'use server';
import { currentUser } from '../../lib/auth.ts';
import { getHub } from '../../lib/uncage-hub.ts';

export type DecideResult = { result: 'ok' | 'not_found' | 'expired' } | { error: { code: string; message: string } };

/** A Server Action: a POST that Next.js only accepts from this site's own Origin. */
export async function decide(code: string, approve: boolean): Promise<DecideResult> {
  const user = await currentUser();
  if (!user) return { error: { code: 'unauthorized', message: 'Sign in again.' } };
  try {
    const hub = await getHub();
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

### ヘッダーとcron

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

```json title="vercel.json"
{ "crons": [{ "path": "/api/uncage/maintenance", "schedule": "0 4 * * *" }] }
```

メンテナンス（保持期間を過ぎたデータの削除、インスタンスが停止したツール呼び出しを失敗として処理すること）は、通常のリクエストの際にも`after`を通じて自動的に実行されます。頻度は全インスタンスを通じて最大で1分に1回です。cronは、リクエストが少ない時間帯のための安全策です。Vercel Hobbyでは1日1回まで、Proでは1時間ごとかそれ以上の頻度で実行できます。

## 環境変数

Vercelプロジェクト（Settings → Environment Variables）でProductionとPreviewに設定し、`next dev`用に`.env.local`にも設定します。

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `DATABASE_URL` | 必須 | Postgresの接続文字列。プール接続のURL（Neonの`-pooler`、トランザクションモードのPgBouncer）も使えます。ハブは最初のリクエストでテーブルを作成します。 |
| `PUBLIC_URL` | 必須 | ユーザーが開く正確なオリジン（例：`https://app.example.com`）。プレビューのURLではなく、本番のドメインを指定します。インストールコマンドとセットアップコマンドに埋め込まれます。 |
| `CRON_SECRET` | 推奨 | ランダムな文字列（`openssl rand -hex 32`）。Vercel Cronはこれを`Authorization: Bearer …`として送ります。ハブの`/maintenance`エンドポイントは、これが設定されている場合にだけ存在します。 |
| 認証用のシークレット | 必須 | `lib/auth.ts`が必要とするもの。 |

## デプロイ

1. **データベースを作成します**。たとえばVercel MarketplaceからNeonを追加する（`DATABASE_URL`が自動で設定されます）か、任意のPostgres 14以降を用意します。ポーリングのたびに往復通信が発生するため、Vercelの関数のリージョンに近いリージョンを選んでください。
2. 上記の**環境変数を設定します**。
3. **デプロイします**。接続済みのGitリポジトリにpushするか、`npx vercel --prod`を実行します。
4. サイトの`/uncage`を**開き**、コンピュータを接続して、以下のチェックリストを確認します。

先に手元のマシンで試す場合は、ローカルのPostgres（`docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=uncage postgres:16-alpine`と`DATABASE_URL=postgres://postgres:uncage@localhost:5432/postgres`）を使って`next build && next start`を実行します。

## 動作を確認する

`https://your.site`は実際の`PUBLIC_URL`に置き換えてください。

- [ ] `curl -s https://your.site/api/uncage/agent/info`の結果に、`http`トランスポートだけが含まれる。

  ```json
  {"protocol":2,"minAgentVersion":"0.3.0","transports":[{"kind":"http","url":"https://your.site/api/uncage/agent"}]}
  ```

- [ ] `curl -s https://your.site/api/uncage/install.sh | head -2`を実行すると、`#!/usr/bin/env bash`と`# Uncage installer…`が表示される。
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://your.site/api/uncage/maintenance`を実行すると、`401`が表示される（`CRON_SECRET`を設定している場合。未設定なら`404`）。シークレットを付けた`curl -s -H "Authorization: Bearer $CRON_SECRET" https://your.site/api/uncage/maintenance`は`{"ran":true,…}`を返す（直近1分以内に別のインスタンスが実行済みの場合は`"ran":false`）。
- [ ] `/uncage`からコンピュータを接続する（ページに実行すべきコマンドが表示されるので、`/device`でコードを承認する）と、数秒以内に**オンライン**と表示される。
- [ ] プロンプトを送ると、回答がストリーミングで表示される。エージェントのログ（ターミナルで実行した`uncage agent`、または`~/.uncage/logs/agent.log`）に約250秒ごとに`http stream rotated`と記録され、ストリームが開き直されてもチャットは動き続ける。
- [ ] Vercelの関数ログで、`/api/uncage/agent/stream`に`504`が出ていない。ストリームは300秒より前にステータス200で終了している。

## FAQ

### 504エラー（`FUNCTION_INVOCATION_TIMEOUT`）が出ます

リクエストが`maxDuration`より長く実行されました。**`stream.maxDurationMs`は`maxDuration`より短く**し、約50秒の余裕を持たせてください。`maxDuration = 300`なら`250_000`（デフォルト）です。`maxDuration`を下げる場合（たとえば60）は、`stream.maxDurationMs`も下げてください（`maxDuration`より少なくとも10秒＝`10_000`短くします）。Proプランでは`maxDuration`を800まで上げられ、それに合わせて`stream.maxDurationMs`も上げられますが、得られるものはわずかです。ストリームの開き直しにかかるコストは再接続1回分にすぎないためです。

### `maxDuration`、`stream.maxDurationMs`、`toolTimeoutMs`の違い

- `maxDuration`（秒単位、`route.ts`で指定）は、このルートへのすべてのリクエストに対するVercelの絶対的な制限です。
- `stream.maxDurationMs`は、クライアントがきれいに再接続できるよう、ハブ自身が長時間のレスポンス（エージェントのストリームとブラウザのイベントストリーム）を終了させるタイミングです。`maxDuration`より短くする必要があります。
- `toolTimeoutMs`は、1つのサイトツールのハンドラーが実行できる時間です。各ツール呼び出しは、エージェントからの1つのリクエストの間に`after`（またはVercelのリクエストコンテキストの`waitUntil`）のもとで処理されるため、リクエストが切れても止まりません。ただし、その処理も`maxDuration`の制約を受けるため、`toolTimeoutMs`はファイルの取得も含めてその範囲に収める必要があります。ハンドラーの途中でVercelが関数を停止した場合、呼び出しは「Site tool "<name>" timed out on the website. Please try again.」というエラーで失敗し、再実行されることはありません（最大1回）。

### 約4MBを超える添付ファイルが失敗します

Vercelは約4.5MBを超えるリクエストボディを、ハブに届く前に独自の`413`で拒否します。ハブ自体は10MiBまで受け付けます。先に`POST /api/uncage/sessions/:id/attachments`の`Content-Length`を確認し、ハブの`attachment_too_large`の形式で応答しない限り、ユーザーには一般的なエラーが表示されます。リファレンスのデモの[ルートハンドラー](https://github.com/ptmafia/uncage/blob/main/examples/connected-demo/app/api/uncage/%5B%5B...path%5D%5D/route.ts)は、4MBの上限でこれを行っています。エージェントの通信には影響しません。エージェントが1回のリクエストで送るのは最大1MBで、ファイルは分割して取得します。

### 遅い回線でアップロードが`400`で失敗します

`bodyTimeoutMs`（デフォルトは30秒）の間バイトが1つも届かない場合、またはボディ全体の受信にその4倍を超える時間がかかった場合、リクエストは`400`で拒否されます。チャンクを受信するたびにタイマーが振り出しに戻るため、遅くても途切れずに続くアップロードは通り、変更が必要になることはほとんどありません。値は`maxDuration`より短くしてください。

### Neonではどのドライバーを使えばよいですか？

`pg`（上記のとおり）か、Neonの`@neondatabase/serverless`の`Pool`を使います（`postgresHubStore({ pool })`はどちらも受け付けます）。HTTP専用の`neon()`関数は使わないでください。ハブは1つの接続上でトランザクションを必要とします。プール接続の`-pooler`のURLは使えます。ハブのマイグレーションはトランザクション単位のロックを取るため、トランザクションモードのプーラーの背後でも動作します。

### Neonの無料プランはスリープしますか？

コンピュータがオンラインの間や、関数インスタンスがウォーム状態の間はスリープしません。開いているエージェントのストリームと`postgresCluster`が0.3〜2秒ごとにポーリングするためです。ユーザーが接続している間は常時稼働のコンピュートを見込んでおくか、[FaaS モードのコスト](/docs/ja/start/choose-deployment-mode/#faas-モードのコスト)を参照してください。

### Redisは必要ですか？

いいえ。インスタンスが多い場合に、遅延とデータベースのポーリングを減らしたいときに追加します（`cluster: redisCluster({ url: process.env.REDIS_URL! })`、`ioredis`をインストール）。Upstash Redisも、TCP上のRedisプロトコル（`rediss://`）に対応していれば使えます。

### 別のプロキシの背後でのレート制限

`toNextHandlers`は、Vercelのエッジが設定する`x-real-ip`を読みます。Vercelの前段に別のプロキシやCDNがある場合、このヘッダーにはそのプロキシのアドレスが入ります。プロキシのクライアントIPヘッダーを使って`toNextHandlers(getHub, { waitUntil: after, clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined })`を渡してください。

### ユーザーに「Agent update needed」（エージェントの更新が必要）と表示されます

そのコンピュータでは0.3より古いエージェントが動いており、HTTPストリーミングで接続できません。ページには対処方法が表示されます。`npm i -g @uncage/cli@latest`を実行してから、セットアップコマンドをもう一度実行します。[トラブルシューティング](/docs/ja/reference/troubleshooting/#エージェントの更新が必要426-upgrade_required)を参照してください。

### サイトツールのハンドラーを数分間実行できますか？

Vercelではできません。ハンドラーは1つのリクエストの中で実行され、`maxDuration`の制約を受けます。時間のかかる処理はバックグラウンドジョブとして開始し、モデルが2つ目のツールで確認できるIDを返すようにするか、ハブを[従来モード](/docs/ja/deploy/node/)でホストしてください。
