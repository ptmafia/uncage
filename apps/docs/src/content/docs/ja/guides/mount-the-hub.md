---
title: ハブをマウントする
description: Next.js のカスタムサーバー、Express、Fastify、Hono に @uncage/hub をマウントする完全なサーバーの例と、createHub の全オプション、プロキシの設定、ウェブサイトが Vercel で動いている場合のハブのホスティング方法を説明します。
---

ハブ（`@uncage/hub`）がサーバーに求めるものは 2 つです。

1. ベースパス（デフォルトは `/api/uncage`）配下の **HTTP リクエスト**：ブラウザ API、デバイスエンドポイント、`install.sh`。`hub.handler(request)`（Fetch API）または `toNodeHandler(hub)`（Node の `req, res, next`）を使います。
2. 接続済みのコンピュータがつないでくる `<basePath>/agent` での **WebSocket のアップグレード**。`hub.attach(httpServer)` が Node の HTTP サーバーにこれを登録します。

そのため、ハブは長時間動き続ける Node プロセス（Node.js 22 以降）で実行します。以下の例はどれも完全なサーバーファイルです。いずれも `./auth` から同じ `getSessionUser` をインポートしており、これはアプリのサインイン処理を表します（[認証とデバイスの承認](/docs/ja/guides/auth-and-device-approval/)を参照）。

```ts title="auth.ts"
import type { HubUser } from '@uncage/hub';

/** Your sign-in: the user a request belongs to, or null. */
export async function getSessionUser(req: Request): Promise<HubUser | null> {
  const cookie = req.headers.get('cookie') ?? '';
  // Look the session cookie up in your session store here.
  return cookie.includes('session=') ? { id: 'user-123', name: 'Ada' } : null;
}
```

## Express

```ts title="express-server.ts"
import { createServer } from 'node:http';
import { createHub, toNodeHandler } from '@uncage/hub';
import express from 'express';
import { getSessionUser } from './auth.ts';

const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
});

const app = express();
// app.set('trust proxy', 1); // behind one reverse proxy: makes req.ip the client address (rate limits)
app.use(toNodeHandler(hub)); // first, before express.json() or compression()
app.use(express.json());
app.get('/', (_req, res) => {
  res.send('Your website');
});

const server = createServer(app);
hub.attach(server);
server.listen(3000, () => console.log('http://localhost:3000'));
```

`toNodeHandler(hub)` が処理するのは `hub.basePath` 配下のパスだけで、それ以外はすべて `next()` に渡します。プレフィックス付きでマウントする（`app.use('/api/uncage', toNodeHandler(hub))`）こともできます。その場合は `req.originalUrl` を読み取ります。

## Fastify

Fastify はリクエストボディを自分でパースするため、ボディパーサーのないスコープをハブ用に用意し、生のリクエストを渡します。

```ts title="fastify-server.ts"
import { createHub, toNodeHandler } from '@uncage/hub';
import Fastify from 'fastify';
import { getSessionUser } from './auth.ts';

const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
});
const hubHandler = toNodeHandler(hub);

const app = Fastify();
await app.register(async (scope) => {
  // Leave the request body unread: the hub streams it itself.
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser('*', (_req, _payload, done) => done(null));
  for (const url of [hub.basePath, `${hub.basePath}/*`]) {
    scope.all(url, (req, reply) => {
      reply.hijack();
      hubHandler(req.raw, reply.raw);
    });
  }
});
app.get('/', async () => 'Your website');

await app.ready();
hub.attach(app.server);
await app.listen({ port: 3000 });
```

## Hono（Node）

`@hono/node-server` では、Fetch の `Request` をそのまま `hub.handler` に渡し、レート制限のためにクライアントのアドレスも渡します。

```ts title="hono-server.ts"
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createHub } from '@uncage/hub';
import { Hono, type Context } from 'hono';
import { getSessionUser } from './auth.ts';

const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
});

const app = new Hono();
const toHub = (c: Context) => hub.handler(c.req.raw, { clientIp: getConnInfo(c).remote.address });
app.all(hub.basePath, toHub);
app.all(`${hub.basePath}/*`, toHub);
app.get('/', (c) => c.text('Your website'));

const server = serve({ fetch: app.fetch, port: 3000 });
hub.attach(server as Server);
```

## Next.js（カスタムサーバー）

Next.js のルートハンドラーは WebSocket のアップグレードを受け付けられません。そこで、Next.js を独自の Node サーバーの中で動かし、その隣にハブを置きます。[Connected モードのクイックスタート](/docs/ja/start/quickstart-connected/)と `connected-demo` の例もこの方法を使っています。

```ts title="server.ts"
import { createServer } from 'node:http';
import { createHub, toNodeHandler } from '@uncage/hub';
import next from 'next';
import { getSessionUser } from './auth.ts';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);

const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  getUser: getSessionUser,
});
// Pages and Server Actions (for example /device) get the hub from here.
(globalThis as Record<symbol, unknown>)[Symbol.for('my-site.uncage-hub')] = hub;
const hubHandler = toNodeHandler(hub);

const server = createServer();
const app = next({ dev, hostname: 'localhost', port, httpServer: server });
const handle = app.getRequestHandler();
await app.prepare();

server.on('request', (req, res) => {
  hubHandler(req, res, () => void handle(req, res));
});
hub.attach(server);
if (dev) {
  const upgrade = app.getUpgradeHandler(); // hot reload
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== `${hub.basePath}/agent`) void upgrade(req, socket, head);
  });
}
server.listen(port);
```

`next dev` の代わりに `node server.ts` で起動します（Node 22.18 以降は TypeScript を直接実行できます）。対応する `package.json` と `tsconfig.json` の設定、およびページ用の型付き `getHub()` ヘルパーはクイックスタートに載っています。

## 素の `node:http`

```ts title="node-server.ts"
import { createServer } from 'node:http';
import { createHub, toNodeHandler } from '@uncage/hub';
import { getSessionUser } from './auth.ts';

const hub = await createHub({ publicUrl: 'http://localhost:3000', getUser: getSessionUser });
const hubHandler = toNodeHandler(hub);

const server = createServer((req, res) => hubHandler(req, res)); // no next(): other paths get 404
hub.attach(server);
server.listen(3000);
```

## 動作を確認する

```sh
curl -s http://localhost:3000/api/uncage/install.sh | head -3   # public: prints the installer
curl -s http://localhost:3000/api/uncage/health                 # needs a signed-in user: 401 without
```

`/health` は、サインイン済みのユーザーには `{"ok":true,"protocol":"1.0","version":"…"}` を、それ以外には `401 unauthorized` を返します。

## `createHub` のオプション

必須なのは `publicUrl` と `getUser` だけです。

| オプション | デフォルト | 役割 |
| --- | --- | --- |
| `publicUrl` | （必須） | ウェブサイトの公開オリジン。例：`https://app.example.com`。インストールとセットアップのコマンド、`/device` へのリンク、CSRF のオリジンチェックに使われます。 |
| `getUser(req)` | （必須） | 認証処理。サインイン済みのブラウザからのリクエストなら `{ id, name? }`、それ以外は `null` を返します。 |
| `basePath` | `/api/uncage` | ハブのマウント先。変更した場合は、同じパスを `UncageProvider` の `baseUrl` に渡してください。 |
| `tools` | `[]` | `defineTool` で定義したサイトツール。[ガイド](/docs/ja/guides/define-tools/) |
| `skills` | `[]` | `SkillSpec[]`。[ガイド](/docs/ja/guides/write-skills/) |
| `selectManifest(ctx)` | すべてのツールとスキル | 実行ごとにツールとスキルを選びます。[ガイド](/docs/ja/guides/select-manifest/) |
| `sessionStorage` | `'machine'` | `'site'` にすると、すべての会話のレプリカを保持します。[ガイド](/docs/ja/guides/site-storage/) |
| `attachmentRetentionDays` | `30` | ウェブサイト経由で送られた添付ファイルのコピーをハブが保持する日数（1 時間ごとに掃除。`Infinity` で無期限に保持）。取り消されたコンピュータの添付ファイルは即座に削除されます。[詳細](/docs/ja/guides/site-storage/#添付ファイル) |
| `store` | `pgliteHubStore({ dataDir: './.uncage-hub' })` | `HubStore`。複数ノードでは `postgresHubStore` を使います。 |
| `cluster` | `memoryCluster()` | `ClusterAdapter`。複数ノードでは `redisCluster` を使います。[ガイド](/docs/ja/guides/multi-node/) |
| `site` | `publicUrl` のホストから得た ID と名前 | ペアリング時にコンピュータに表示される `{ id?, name? }`。`id` は変えないでください。 |
| `verificationPath` | `/device` | 承認ページ。[ガイド](/docs/ja/guides/auth-and-device-approval/) |
| `minAgentVersion` | このハブのバージョン | これより古いエージェントにはアップグレードを指示します（`upgrade_required`）。エージェントは `npm i -g @uncage/cli@latest` を実行して再接続します。 |
| `cliVersionRange` | ハブの `^<major.minor>` | `install.sh` がインストールする `@uncage/cli` のバージョン（`^0.2`、`~0.2.1`、`0.2.0`、`latest`）。 |
| `heartbeat` | `{ pingIntervalMs: 10000, missedPings: 2 }` | 応答のないコンピュータは約 30 秒後にオフライン表示になります。 |
| `sseHeartbeatMs` | `15000` | ブラウザのイベントストリームに送るキープアライブのコメントの間隔。 |
| `commandTimeoutMs` | `30000` | ブラウザのリクエストがコンピュータの応答を待つ時間。 |
| `toolTimeoutMs` | `120000` | この時間を過ぎても実行中のツールハンドラーは `tool_failed` で失敗します。 |
| `maxConcurrentToolCalls` | `8` | 1 台のコンピュータで同時に実行できるツール呼び出しの数。 |
| `rateLimits` | 下記参照 | デバイスログインの不正利用対策の制限。 |

`rateLimits`：`deviceCodesPerMinute`（クライアント IP ごとに 20）、`userCodeWindowMs`（10 分）あたりの `userCodeFailures`（ユーザーごとにコード推測の失敗 10 回）、`clientIp(req)` と `trustForwardedFor`（[プロキシの背後で](#リバースプロキシやロードバランサーの背後で)を参照）。制限を超えると `429 rate_limited` が返ります。制限はノードごとにカウントされます。

戻り値の `Hub` には、`basePath`、`handler(req, info?)`、`attach(server, { path? })`、`approveDevice`、`denyDevice`、`lookupDevice`、`revokeMachine`、`close()` があります。`close()` がストアとクラスターを閉じるのは、ハブ自身がそれらを作成した場合だけです。自分で作成したものは、その後で閉じてください。

## リバースプロキシやロードバランサーの背後で

:::caution[本番公開の前にクライアント IP を設定する]
`POST <basePath>/device/code`（`uncage setup` のたびに呼ばれます）には、**クライアント IP ごとに 1 分あたり 20 回**の制限があります。リバースプロキシ、ロードバランサー、CDN の背後では、設定しない限りハブにはユーザーではなくプロキシのアドレスが見えます。すると**全ユーザーが 1 つのバケットを共有する**ことになり、サイト全体で 1 分間に 21 回目のセットアップから、`uncage setup` が `429 rate_limited` で失敗します。

次のいずれかで解決してください。

- Express：`app.set('trust proxy', 1)`（アプリの前段にあるプロキシの数）。これで `toNodeHandler` が `req.ip` を渡します。
- どのサーバーでも：`rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined }`（利用しているプラットフォームのクライアント IP ヘッダーを使います）。
- `rateLimits: { trustForwardedFor: true }`。プロキシがクライアントのアドレスを `X-Forwarded-For` に追記する場合に限ります（ハブは一番右のエントリーを使います）。
:::

- `<basePath>/agent` の **WebSocket のアップグレードを転送し**（nginx：`proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`）、長時間の接続を許可してください（ハブは 10 秒ごとに ping を送ります）。
- **元の `Host` を維持します**（nginx：`proxy_set_header Host $host;`）。ハブはリクエストの `Origin` を `publicUrl` および `Host` と比較し、クロスサイトの POST を拒否します。
- `<basePath>/sessions/*/events` の **SSE はバッファリングしません**（nginx：`proxy_buffering off;`）。
- **レート制限のためのクライアント IP。** Express では `app.set('trust proxy', 1)` を設定すれば、`toNodeHandler` が `req.ip` を使います。Fetch スタイルのサーバーでは `rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined }`（またはプラットフォームのヘッダー）を渡すか、プロキシがクライアントのアドレスを `X-Forwarded-For` に追記するなら `trustForwardedFor: true` を指定します。どれも設定しないと、すべてのクライアントがプロキシのアドレス（または 1 つの `shared` バケット）としてカウントされ、制限が全ユーザー合計にかかります。
- **TLS。** どこで終端してもかまいませんが、`publicUrl` はユーザーが開く `https://` の URL でなければなりません。エージェントは、`localhost` と `127.0.0.1` 以外への平文の `http://` 接続を拒否します。

## サーバーレスでのホスティング（Vercel、Netlify）

サーバーレス関数は WebSocket を保持できないため、ハブをホストできません。サイトはそのままにして、WebSocket をサポートするホスト（Fly.io、Railway、Render、コンテナ、VM）で、ハブを小さな Node サービス（上のいずれかのサーバー）として動かしてください。ブラウザ API はサイトの Cookie と同一オリジンのチェックに依存しているため、ハブはサイトと**同じオリジン**にする必要があります。

- エッジ（ロードバランサー、Cloudflare、両方の前段に置いた nginx など）で、`https://your.site/api/uncage/*` を **WebSocket のアップグレードも含めて**ハブのサービスにルーティングします。Vercel の rewrites は WebSocket をプロキシしないため、これは Vercel の内部ではなく前段で行ってください。
- `publicUrl` を `https://your.site` に設定します。
- `getUser` では、フレームワークのヘルパーを使わずにサイトのセッション Cookie を検証します。たとえば、認証ライブラリが発行する署名付き JWT を検証するか、共有のセッションデータベースでセッション ID を照会します。
- 承認ページはサイトに置いたままです。ただし承認ページには `hub.approveDevice` が必要で、これはハブのプロセスにしかありません。`/device` もハブのサービスから配信する（そちらにルーティングする）か、承認ページから呼び出す、認証と CSRF 対策を備えた小さなエンドポイントをハブのサービスに用意してください。
