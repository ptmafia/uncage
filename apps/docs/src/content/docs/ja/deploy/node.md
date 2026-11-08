---
title: Node（従来モード）
description: 外部依存ゼロ（PGlite + WebSocket）の常駐Node.jsプロセスにハブをデプロイし、リバースプロキシの背後で運用する方法を、完全なサーバーコード、環境変数、デプロイ手順、確認チェックリスト、FAQとともに説明します。
---

従来モード（常駐プロセス）は、動き続けるNode.jsプロセスの中でハブを実行する方式です。VM、コンテナ、Railway、Fly.io、Render、自前のサーバーなどが該当します。**外部サービスは一切不要**です。ハブは組み込みのPostgres（PGlite）のフォルダにデータを保存し、ユーザーのコンピュータはハブとのWebSocketを維持します。どちらのモードにすべきか迷う場合は、[デプロイモードを選ぶ](/docs/ja/start/choose-deployment-mode/)を参照してください。

## 前提条件

- Node.js **22.18以降**：以下の`.ts`サーバーをビルドなしで直接実行できます（それより古いバージョンでは`--experimental-strip-types`を付けるか、先に`tsc`でコンパイルしてください）。
- プロセスを動かし続け、ハブのデータフォルダ（`.uncage-hub`）用に**永続ディスク**を提供できるホスト。永続ディスクがないと、再起動のたびにペアリング済みのコンピュータの情報が失われ、ユーザーは`uncage setup`をやり直す必要があります。
- 前段に置くプロキシまたはロードバランサー。`/api/uncage/agent`での**WebSocketのアップグレード**を転送し（多くのホストではデフォルトで転送されます）、`https://`で配信できること。
- Fetchの`Request`から読み取れるアプリのサインイン情報（セッションCookie）。

```sh
npm i @uncage/hub express
```

## コード

ファイルは2つです。`auth.ts`はアプリのサインイン処理を表すものなので、中身を置き換えてください。

```ts title="auth.ts"
import type { HubUser } from '@uncage/hub';

/** Your sign-in: the user a request belongs to, or null. */
export async function getSessionUser(req: Request): Promise<HubUser | null> {
  const cookie = req.headers.get('cookie') ?? '';
  // Look the session cookie up in your session store here.
  return cookie.includes('session=') ? { id: 'user-123', name: 'Ada' } : null;
}
```

```ts title="server.ts"
import { createServer } from 'node:http';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import express from 'express';
import { getSessionUser } from './auth.ts';

const port = Number(process.env.PORT ?? 3000);

// Embedded Postgres in a folder: one process per folder, kept across restarts.
const store = await pgliteHubStore({ dataDir: process.env.UNCAGE_DATA_DIR ?? './.uncage-hub' });
const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  getUser: getSessionUser,
  store,
  sessionStorage: 'site', // keep a copy of every conversation on your site
});

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY)); // proxies in front: req.ip is the client
app.use(toNodeHandler(hub)); // first, before express.json() or compression()
app.use(express.json());
app.get('/', (_req, res) => {
  res.send('Your website');
});

const server = createServer(app);
attachWebSocket(hub, server); // computers connect to ws(s)://<host>/api/uncage/agent
server.listen(port, () => console.log(`ready on http://localhost:${port}`));

// On deploy or restart: stop taking requests, let running site tools finish, then close the store.
process.once('SIGTERM', () => {
  server.close();
  void hub
    .close()
    .then(() => store.close())
    .finally(() => process.exit(0));
});
```

各部分の役割は次のとおりです。

- `toNodeHandler(hub)`は`/api/uncage`配下のすべて（ブラウザAPI、デバイスログイン、`install.sh`と`install.ps1`、HTTPストリーミングのトランスポート）を処理し、それ以外のパスは`next()`に渡します。IPごとのレート制限のために、`req.ip`をハブに渡します。
- `attachWebSocket(hub, server)`は同じHTTPサーバーでコンピュータからのWebSocketを受け付け、ハブのメンテナンス（保持期間を過ぎたデータの削除）を毎分実行します。これにより、ハブは両方のトランスポートを提供します。エージェントは通常WebSocketを使い、WebSocketの失敗が続く場合（アップグレードを遮断するプロキシがある場合など）は自動的にHTTPストリーミングに切り替えます。
- `hub.close()`は`store`を閉じません。ハブを閉じた後に`store`を閉じてください。

Expressではなく、Fastify、Hono、Next.jsのカスタムサーバーを使う場合は、[ハブをマウントする](/docs/ja/guides/mount-the-hub/)にそれぞれの完全なサーバー例があります。Next.jsだけで構成する場合は、[Connected モードのクイックスタート](/docs/ja/start/quickstart-connected/)でこの構成をNext.jsアプリに組み込む手順を説明しています。

## 環境変数

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `PUBLIC_URL` | 本番環境では必須 | ユーザーが開く正確なオリジン（例：`https://app.example.com`）。インストールコマンドとセットアップコマンドに埋め込まれるため、`https://`である必要があります（`http://`は`localhost`の場合のみ可）。 |
| `PORT` | 任意 | 待ち受けるポート（デフォルトは`3000`）。 |
| `UNCAGE_DATA_DIR` | 任意 | ハブのPGliteフォルダ（デフォルトは`./.uncage-hub`）。永続ディスク上に置き、`.gitignore`に追加してください。 |
| `TRUST_PROXY` | プロキシの背後では必須 | アプリの前段にあるプロキシの数。`app.set('trust proxy', …)`に使います。設定しないと、全ユーザーが1つのレート制限枠を共有することになります（FAQを参照）。 |

これらの変数名はこのページで決めたものです。ハブ自体は環境変数を読みません。

## デプロイ

1. **ビルドして起動します**。`node server.ts`で起動します（Node 22.18以降）。コンテナの場合の例：

   ```dockerfile title="Dockerfile"
   # Node 22.18 or newer runs server.ts directly (type stripping); node:22 is the latest 22.x.
   FROM node:22-slim
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --omit=dev
   COPY . .
   ENV UNCAGE_DATA_DIR=/data/uncage-hub
   VOLUME /data
   EXPOSE 3000
   CMD ["node", "server.ts"]
   ```

2. **データフォルダ（上の例では`/data`）に永続ボリュームを割り当てます**。Railway、Fly.io、Renderではvolumeまたはdiskと呼ばれています。
3. **`PUBLIC_URL`を設定します**。値は`https://`のオリジンです。プロキシやロードバランサーが前段にある場合（プラットフォーム上ではほぼ常にそうです）は、`TRUST_PROXY=1`も設定します。
4. **前段のプロキシを確認します**。
   - `/api/uncage/agent`でのWebSocketのアップグレードを転送し、アイドルタイムアウトが30秒を超えていること（ハブは10秒ごとにpingを送ります）。
   - `text/event-stream`（ブラウザ向けイベント）や`application/x-ndjson`（エージェントのストリーム）のレスポンスをバッファリングしないこと。
   - 元の`Host`ヘッダーを維持すること。

   nginxの場合の例：

   ```nginx title="nginx.conf (excerpt)"
   location / {
     proxy_pass http://127.0.0.1:3000;
     proxy_http_version 1.1;
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_buffering off;
     proxy_read_timeout 300s;
   }
   ```

5. **データフォルダ1つにつきプロセスは1つにします**。PGliteはフォルダをロックします。複数のプロセスで動かす場合は、[マルチノード](/docs/ja/guides/multi-node/)を参照してください。

## 動作を確認する

`https://your.site`は実際の`PUBLIC_URL`に置き換えてください。

- [ ] `curl -s https://your.site/api/uncage/install.sh | head -2`を実行すると、`#!/usr/bin/env bash`と`# Uncage installer…`が表示される。
- [ ] `curl -s https://your.site/api/uncage/agent/info`の結果に**両方**のトランスポートが含まれ、`ws`が先頭にある。

  ```json
  {"protocol":2,"minAgentVersion":"0.3.0","transports":[{"kind":"ws","url":"wss://your.site/api/uncage/agent"},{"kind":"http","url":"https://your.site/api/uncage/agent"}]}
  ```

  `http`しかない場合は、このプロセスで`attachWebSocket`が実行されていません。
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://your.site/api/uncage/health`を実行すると、`401`が表示される（サインアウト状態）。サインインしたブラウザでは`{"ok":true,…}`が返る。
- [ ] コンピュータでページに表示されるコマンド（または`uncage setup https://your.site`）を実行し、`/device`でコードを承認すると、ページ上でコンピュータが**オンライン**と表示される。
- [ ] サーバーを再起動しても、`uncage setup`をやり直すことなく、約30秒以内にコンピュータがオンラインに戻る（データフォルダが残っている）。

## FAQ

### サイトはVercelやNetlifyにあります。それでも従来モードを使えますか？

はい、別のサービスとして使えます。このサーバーをWebSocketが使えるホストで動かし、エッジ（ロードバランサー、Cloudflare、両方の前段に置いたnginxなど）で`https://your.site/api/uncage/*`を**WebSocketのアップグレードも含めて**このサーバーにルーティングし、サイトと**同一オリジン**にしてください。ブラウザAPIはサイトのCookieと同一オリジンのチェックに依存しているためです。VercelのrewritesはWebSocketをプロキシしません（その場合エージェントはHTTPストリーミングにフォールバックします。動作はしますが、即時配信の利点は失われます）。`getUser`では、フレームワークのヘルパーを使わずにサイトのセッションCookieを検証してください（たとえば認証ライブラリが発行する署名付きJWTを検証します）。`/device`の承認ページには`hub.approveDevice`が必要で、これはこのプロセスにあります。`/device`もこのプロセスから配信するか、ページから呼び出せる、認証とCSRF対策を備えた小さなエンドポイントを公開してください。多くの場合は、[VercelでFaaS モード](/docs/ja/deploy/vercel/)を直接使うほうが簡単です。

### 多数のユーザーが同時に使うと、`uncage setup`が`429 rate_limited`で失敗します

プロキシの背後では、特に設定しない限りハブにはプロキシのアドレスが見えるため、全ユーザーが「1分あたり20個のデバイスコード」という1つの枠を共有します。`TRUST_PROXY`（上記）を設定するか、プロキシのクライアントIPヘッダーを使って`rateLimits: { clientIp: (req) => req.headers.get('x-real-ip') ?? undefined }`を渡してください。詳しくは[リバースプロキシやロードバランサーの背後で](/docs/ja/guides/mount-the-hub/#リバースプロキシやロードバランサーの背後で)を参照してください。

### プロキシがWebSocketを遮断しています。それでも動きますか？

はい。WebSocketの接続に3回失敗すると、エージェントはHTTPストリーミング（同じ`toNodeHandler`が処理します）に切り替え、30分ごとにWebSocketを再試行します。それでもプロキシは修正してください。WebSocketのほうがコマンドを即座に届けられ、コストも低く済みます。

### PGliteの代わりにPostgresを使えますか？

はい。`store: await postgresHubStore({ connectionString: process.env.DATABASE_URL! })`を使います（`pg`をインストールしてください）。マネージドなバックアップが必要な場合や、複数のノードで動かす場合に切り替えます。プール接続の接続文字列（PgBouncer、Neonの`-pooler`）も使えます。マイグレーションはトランザクション単位のロックを使うためです。

### Redisは必要ですか？

プロセスが1つなら不要です。複数のノードで動かす場合は、[マルチノード](/docs/ja/guides/multi-node/)のとおりに`redisCluster`（または`postgresCluster`）を追加してください。

### デプロイでサーバーが再起動しました。実行中の作業はどうなりますか？

コンピュータは自動的に再接続します（バックオフは1秒から最大30秒）。Runはユーザーのコンピュータ上で続行され、そのイベントは再接続時に補完されます。プロセスの停止時にまだ実行中だったサイトツールのハンドラーは、「Site tool "<name>" timed out on the website. Please try again.」というエラーで失敗します。なお、`hub.close()`は実行中のハンドラーが完了できるよう、先に`toolDrainMs`（5秒）の猶予を与えます。

### 古いエージェント（0.2）が接続できません

ハブはこれらのエージェントにアップグレードを求め（`upgrade_required`）、0.2のエージェントは`npm i -g @uncage/cli@latest`で自動的にアップグレードします。[トラブルシューティング](/docs/ja/reference/troubleshooting/#エージェントの更新が必要426-upgrade_required)を参照してください。
