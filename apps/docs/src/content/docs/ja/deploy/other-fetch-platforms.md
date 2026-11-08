---
title: その他のFetch対応プラットフォーム（FaaS モード）
description: FetchのRequest/Responseに対応する任意のプラットフォーム（Netlify Functions、Deno、Bun、その他のサーバーレスホスト）で、hub.fetchとPostgresを使ってハブを動かす方法を説明します。プラットフォームに求められる要件、完全なファイル、環境変数、デプロイ手順、確認チェックリスト、FAQを掲載しています。
---

`hub.fetch(request)`は素のFetchハンドラーです。`Request`を受け取って`Response`を返し、Web APIだけを使います。Fetchハンドラーを実行でき、レスポンスをストリーミングできるプラットフォームであれば、どこでもFaaS モードでハブをホストできます。このページでは、Netlify FunctionsとBun / Denoを例に、一般的な手順を説明します。VercelとCloudflare Workersについては、それぞれのページ（[VercelでNext.js](/docs/ja/deploy/vercel/)、[Cloudflare Workers](/docs/ja/deploy/cloudflare-workers/)）を参照してください。

:::note[ステータス]
ハブはこれらのプラットフォームでも、VercelやWorkersと同じ`hub.fetch`を通じて動作しますが、Uncageチームはプラットフォームごとのエンドツーエンドの検証は行っていません。以下のチェックリストを使えば、お使いのプラットフォームで動くかどうかを数分で確認できます。
:::

:::caution[Netlify：制限時間が短い]
Netlifyのドキュメントには、**ストリーミング関数の実行時間の上限は60秒**（ストリーミングレスポンス1つあたり20MBまで）と記載されています。ハブはこの範囲内で動作しますが、注意点があります。`UNCAGE_STREAM_MAX_MS`を約`50000`に設定してください（ストリームが約50秒ごとに開き直されるため、Vercelより再接続と関数呼び出しの回数が増えます）。また、サイトツールの呼び出しはすべて1回の関数呼び出しの中で完了する必要があるため、`toolTimeoutMs`は60秒より十分短く（たとえば`40_000`）してください。ツールにそれ以上の時間が必要な場合は、[Vercel](/docs/ja/deploy/vercel/)か[従来モード](/docs/ja/deploy/node/)を使ってください。
:::

## 前提条件

プラットフォームには次の要件があります。

1. **レスポンスをバッファリングせずにストリーミングできること**。エージェントのストリーム（`application/x-ndjson`）とブラウザのイベント（`text/event-stream`）は、数分間にわたって行を送り続けます。
2. **1つのリクエストを少なくとも約30秒、できれば数分間実行できること**。`stream.maxDurationMs`はその制限より短く設定します。サイトツールの呼び出しもそれぞれ1つのリクエストの中で実行されるため、`toolTimeoutMs`も制限内に収める必要があります。
3. **`pg`またはpg互換の`Pool`でPostgresに接続できること**（Neonの`@neondatabase/serverless`の`Pool`は使えます。HTTP専用のクエリ関数は使えません。ハブはトランザクションを必要とするためです）。
4. IPごとのレート制限のために、**クライアントIP**（ヘッダーまたはコンテキストのフィールド）を取得できること。

**強く推奨**：`waitUntil(promise)`フック。ツール呼び出しはこのフックのもとで実行されるため、接続が切れてもハンドラーが途中で打ち切られることがなく、メンテナンスと後始末もレスポンスの後に実行されます。あると便利なもの：cron機能（メンテナンス用エンドポイントのため）。

プラットフォームがリクエスト間でのソケットの共有を禁止している場合（Workersなど）は、[Workersのページ](/docs/ja/deploy/cloudflare-workers/#コード)のように、`fetchOnce`でリクエストごとにハブを作成してください。

```sh
npm i @uncage/hub pg
npm i -D @types/pg
```

## コード

ハブはインスタンス（プロセスまたはisolate）ごとに1回作成し、そのインスタンスが処理するすべてのリクエストで再利用します。

```ts title="hub.ts"
import { createHub, postgresCluster, postgresHubStore, type Hub, type HubUser } from '@uncage/hub';
import pg from 'pg';

/** Your sign-in: verify the session cookie of a request. Replace the body. */
async function getUser(req: Request): Promise<HubUser | null> {
  const cookie = req.headers.get('cookie') ?? '';
  // Look the session cookie up in your session store here.
  return cookie.includes('session=') ? { id: 'user-123', name: 'Ada' } : null;
}

async function createAppHub(): Promise<Hub> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  pool.on('error', (err) => console.error('postgres pool error:', err.message));
  const ipHeader = process.env.CLIENT_IP_HEADER?.toLowerCase();
  const publicUrl = process.env.PUBLIC_URL ?? (process.env.VERCEL ? undefined : 'http://localhost:3000');
  if (!publicUrl) throw new Error('PUBLIC_URL is not set: set it to your site’s https:// origin.');
  return createHub({
    publicUrl, // what users open; localhost only for local development
    getUser,
    store: await postgresHubStore({ pool }),
    cluster: postgresCluster({ pool }),
    sessionStorage: 'site',
    // Below the platform's request time limit (default 250 s).
    stream: { maxDurationMs: Number(process.env.UNCAGE_STREAM_MAX_MS) || 250_000 },
    ...(ipHeader ? { rateLimits: { clientIp: (req: Request) => req.headers.get(ipHeader) ?? undefined } } : {}),
    ...(process.env.CRON_SECRET ? { maintenance: { secret: process.env.CRON_SECRET } } : {}),
  });
}

let hub: Promise<Hub> | undefined;

/** The hub of this instance; a failed start (database briefly down) is retried on the next request. */
export function getHub(): Promise<Hub> {
  const p = (hub ??= createAppHub());
  p.catch(() => {
    if (hub === p) hub = undefined;
  });
  return p;
}
```

### Netlify Functions

```ts title="netlify/functions/uncage.ts"
import { getHub } from '../../hub.ts';

/** The fields of Netlify's function context used here. */
interface NetlifyContext {
  ip: string;
  waitUntil(p: Promise<unknown>): void;
}

export default async (req: Request, context: NetlifyContext): Promise<Response> => {
  const hub = await getHub();
  return hub.fetch(req, { clientIp: context.ip, waitUntil: (p) => context.waitUntil(p) });
};

export const config = { path: '/api/uncage/*' };
```

### BunまたはDeno（常駐するFetchサーバー）

どちらも、デフォルトエクスポートに`fetch`ハンドラーを持つファイルを実行します。`bun server.ts`（Bunはエクスポートから`port`を読み取ります）または`deno serve --port 3000 server.ts`で起動します。プロセスは動き続けるため、ハブもプロセスと同じだけ存続します。

```ts title="server.ts"
import { getHub } from './hub.ts';

/** Bun passes its server as the second argument, `deno serve` a connection info object. */
interface BunServer {
  requestIP(req: Request): { address: string } | null;
}
interface DenoServeInfo {
  remoteAddr: { hostname: string };
}

function clientIpOf(req: Request, second: unknown): string | undefined {
  const s = second as Partial<BunServer & DenoServeInfo> | undefined;
  if (typeof s?.requestIP === 'function') return s.requestIP(req)?.address;
  return s?.remoteAddr?.hostname;
}

export default {
  port: 3000,
  async fetch(req: Request, second?: unknown): Promise<Response> {
    if (new URL(req.url).pathname.startsWith('/api/uncage/')) {
      const hub = await getHub();
      // The socket address; behind a proxy set CLIENT_IP_HEADER instead (it wins, see hub.ts).
      const clientIp = clientIpOf(req, second);
      return hub.fetch(req, clientIp ? { clientIp } : {});
    }
    return new Response('Your website');
  },
};
```

`/device`の承認ページも必要です（サインイン中のユーザーだけが使え、フレーム内には表示されず、自サイトのオリジンからのPOSTで判定します）。このページは`hub.lookupDevice`、`hub.approveDevice`、`hub.denyDevice`を呼び出します。[Workersのページ](/docs/ja/deploy/cloudflare-workers/#コード)に、流用できるフレームワーク非依存の実装（`devicePage`）があります。守るべきルールは[認証とデバイスの承認](/docs/ja/guides/auth-and-device-approval/)で説明しています。

## 環境変数

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `DATABASE_URL` | 必須 | Postgresの接続文字列。プール接続のURL（トランザクションモードのPgBouncer、Neonの`-pooler`）も使えます。 |
| `PUBLIC_URL` | 必須 | ユーザーが開く正確な`https://`のオリジン。 |
| `UNCAGE_STREAM_MAX_MS` | プラットフォームの制限が300秒未満の場合 | ハブが長時間のレスポンスを終了させるタイミング。プラットフォームのリクエストの制限時間より10〜50秒程度短くします。 |
| `CLIENT_IP_HEADER` | プロキシの背後では必須 | クライアントのアドレスを運ぶヘッダー（例：`x-real-ip`、`cf-connecting-ip`、`x-nf-client-connection-ip`）。すべてのリクエストが確実にそのプロキシを経由する場合にだけ設定してください。 |
| `CRON_SECRET` | 任意 | プラットフォームのcronのために、`Authorization: Bearer <secret>`付きの`GET /api/uncage/maintenance`を有効にします。 |

これらの変数名はこのページで決めたものです。ハブ自体は環境変数を読みません。

## デプロイ

1. **データベースを作成し**、プラットフォームで`DATABASE_URL`と`PUBLIC_URL`を設定します。
2. プラットフォームのドキュメントで、ご利用のプランの**リクエストの制限時間を確認し**、`UNCAGE_STREAM_MAX_MS`をそれより短く設定します（300秒以上なら不要です）。
3. プラットフォームが想定する方法で**デプロイします**（Netlifyなら上記の関数を用意して`netlify deploy --prod`、BunやDenoならホスト上で`bun server.ts`または`deno serve --port 3000 server.ts`を実行します）。
4. **任意**：`CRON_SECRET`のBearerトークンを付けて、`/api/uncage/maintenance`を毎日呼び出すようスケジュールします。設定しなくても、メンテナンスはリクエストの際に随時実行されます。

## 動作を確認する

- [ ] `curl -s https://your.site/api/uncage/agent/info`が`http`トランスポートを返す（`{"protocol":2,…,"transports":[{"kind":"http",…}]}`）。
- [ ] `curl -sN https://your.site/api/uncage/agent/stream`がすぐに`401`を返す（トークンなし）。これで、ルートがハブに届いていることを確認できます。
- [ ] コンピュータを接続する（`uncage setup https://your.site`を実行し、`/device`で承認する）と、**オンライン**と表示され、プラットフォームの制限時間より長くオンラインのままである。エージェントのログには、エラーではなく`http stream rotated`の行が記録される。
- [ ] チャットで、プロンプトへの回答が最後にまとめてではなく、**書かれていく途中から**ストリーミングで表示される。一度にまとめて届く場合、そのプラットフォームはレスポンスをバッファリングしており、ハブをホストできません。
- [ ] サイトツールの呼び出しが完了する。

## FAQ

### 動かないことがわかっているプラットフォームはありますか？

レスポンス全体をバッファリングしてから送信するプラットフォームや、リクエストを数秒に制限するプラットフォームでは動きません。ハブには、少なくとも約30秒間開いたままになるストリーミングレスポンスが必要です。

### 単一の常駐プロセスなら、Postgresなしで済ませられますか？

Fetchサーバーが1つの常駐プロセス（VM上のBunやDeno）であれば、実質的には従来モードです。WebSocketと組み込みのストアを使うなら、Nodeと`@uncage/hub/node`を使ってください（[Nodeのページ](/docs/ja/deploy/node/)）。他のランタイムでは、Postgresを使い続けてください（組み込みのストアとWebSocketサーバーは、Node上でしかテストされていません）。

### プラットフォームの制限時間はどこまで短くても大丈夫ですか？

ハブは数秒を超える`stream.maxDurationMs`であれば動作しますが、ストリームを開き直すたびに再接続が発生し、ツール呼び出しもすべて制限時間内に完了する必要があります。約30秒を下回るなら、使う価値はありません。

### 504が出る、接続が切れる

リクエストがプラットフォームの制限より長く続きました。`UNCAGE_STREAM_MAX_MS`を下げ、`toolTimeoutMs`（デフォルトは120秒）も制限より短くしてください。プロキシやネットワークによる接続の切断は問題ありません。エージェントはカーソルを使って再接続し、何も失われず、二重に届くこともありません。
