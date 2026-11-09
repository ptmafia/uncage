---
title: ハブをマウントする
description: Express、Fastify、Hono、Next.jsのカスタムサーバー、素のnode:httpに@uncage/hubをマウントする完全なNodeサーバーの例（従来モード）、サーバーレスプラットフォーム向けのFetchハンドラーとしてのハブ、createHubの全オプション、プロキシの設定を説明します。
---

ハブはFetchハンドラーです。`hub.fetch(request)`が、ベースパス（デフォルトは`/api/uncage`）配下のすべて、つまりブラウザAPI、デバイスログイン、`install.sh` / `install.ps1`、コンピュータとのHTTPストリーミングのトランスポートに応答します。マウントの方法は、ウェブサイトがどこで動いているかによって変わります（[デプロイモードを選ぶ](/docs/ja/start/choose-deployment-mode/)）。

- **常駐するNodeプロセス（従来モード）**：このページで説明します。`@uncage/hub/node`の`toNodeHandler(hub)`が`hub.fetch`をNodeのミドルウェアとしてマウントし、`attachWebSocket(hub, server)`がHTTPサーバー上でコンピュータからのWebSocketを受け付けます。ストアは`pgliteHubStore`（フォルダ内の組み込みPostgres）なので、他に動かすものはありません。
- **サーバーレスまたはFetch対応プラットフォーム（FaaS モード）**：[VercelでNext.js](/docs/ja/deploy/vercel/)（`toNextHandlers`）、[Cloudflare Workers](/docs/ja/deploy/cloudflare-workers/)（`fetchOnce`）、[その他のFetch対応プラットフォーム](/docs/ja/deploy/other-fetch-platforms/)（`hub.fetch`）を参照してください。これらにはPostgresが必要です。

以下の例はどれも、Node.js 22以降で動く完全なサーバーファイルです。いずれも`./auth`から同じ`getSessionUser`をインポートしており、これはアプリのサインイン処理を表します（[認証とデバイスの承認](/docs/ja/guides/auth-and-device-approval/)を参照）。

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
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import express from 'express';
import { getSessionUser } from './auth.ts';

const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
  store,
});

const app = express();
// app.set('trust proxy', 1); // behind one reverse proxy: makes req.ip the client address (rate limits)
app.use(toNodeHandler(hub)); // first, before express.json() or compression()
app.use(express.json());
app.get('/', (_req, res) => {
  res.send('Your website');
});

const server = createServer(app);
attachWebSocket(hub, server); // computers connect to ws(s)://<host>/api/uncage/agent
server.listen(3000, () => console.log('http://localhost:3000'));
```

`toNodeHandler(hub)`が処理するのは`hub.basePath`配下のパスだけで、それ以外はすべて`next()`に渡します。プレフィックス付きでマウントする（`app.use('/api/uncage', toNodeHandler(hub))`）こともできます。その場合は`req.originalUrl`を読み取ります。

## Fastify

Fastifyはリクエストボディを自分でパースするため、ボディパーサーのないスコープをハブ用に用意し、生のリクエストを渡します。

```ts title="fastify-server.ts"
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import Fastify from 'fastify';
import { getSessionUser } from './auth.ts';

const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
  store,
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
attachWebSocket(hub, app.server);
await app.listen({ port: 3000 });
```

## Hono（Node）

`@hono/node-server`では、Fetchの`Request`をそのまま`hub.fetch`に渡し、レート制限のためにクライアントのアドレスも渡します。

```ts title="hono-server.ts"
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore } from '@uncage/hub/node';
import { Hono, type Context } from 'hono';
import { getSessionUser } from './auth.ts';

const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
  store,
});

const app = new Hono();
const toHub = (c: Context) => hub.fetch(c.req.raw, { clientIp: getConnInfo(c).remote.address });
app.all(hub.basePath, toHub);
app.all(`${hub.basePath}/*`, toHub);
app.get('/', (c) => c.text('Your website'));

const server = serve({ fetch: app.fetch, port: 3000 });
attachWebSocket(hub, server as Server);
```

## Next.js（カスタムサーバー）

Next.jsアプリで従来モード（WebSocket、組み込みのストア、運用すべきデータベースなし）を使い続けるには、Next.jsを独自のNodeサーバーの中で動かし、その隣にハブを置きます。ルートハンドラーはWebSocketのアップグレードを受け付けられないためです。[Connected モードのクイックスタート](/docs/ja/start/quickstart-connected/)と`connected-demo`の例もこの方法を使っています（カスタムサーバーを使わない場合は、代わりにルートハンドラーにハブをマウントします。[VercelでNext.js](/docs/ja/deploy/vercel/)を参照してください。この方法は`next start`でも動きます）。

```ts title="server.ts"
import { createServer } from 'node:http';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import next from 'next';
import { getSessionUser } from './auth.ts';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);

const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  getUser: getSessionUser,
  store: await pgliteHubStore({ dataDir: './.uncage-hub' }),
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
attachWebSocket(hub, server);
if (dev) {
  const upgrade = app.getUpgradeHandler(); // hot reload
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== `${hub.basePath}/agent`) void upgrade(req, socket, head);
  });
}
server.listen(port);
```

`next dev`の代わりに`node server.ts`で起動します（Node 22.18以降はTypeScriptを直接実行できます）。対応する`package.json`と`tsconfig.json`の設定、およびページ用の型付き`getHub()`ヘルパーはクイックスタートに載っています。

## 素の`node:http`

```ts title="node-server.ts"
import { createServer } from 'node:http';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import { getSessionUser } from './auth.ts';

const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
const hub = await createHub({ publicUrl: 'http://localhost:3000', getUser: getSessionUser, store });
const hubHandler = toNodeHandler(hub);

const server = createServer((req, res) => hubHandler(req, res)); // no next(): other paths get 404
attachWebSocket(hub, server);
server.listen(3000);
```

## 動作を確認する

```sh
curl -s http://localhost:3000/api/uncage/install.sh | head -3   # public: prints the installer
curl -s http://localhost:3000/api/uncage/agent/info             # public: protocol and offered transports
curl -s http://localhost:3000/api/uncage/health                 # needs a signed-in user: 401 without
```

このプロセスで`attachWebSocket`が実行されていれば、`/agent/info`には`ws`、`http`の順に表示されます（実行されていなければ`http`だけです）。`/health`は、サインイン済みのユーザーには`{"ok":true,"protocol":"1.0","version":"…"}`を、それ以外には`401 unauthorized`を返します。

`.uncage-hub/`を`.gitignore`に追加し、本番環境ではこのフォルダを永続ディスク上に置いてください。ペアリング済みのコンピュータの情報が入っています。1つのフォルダにつきプロセスは1つです（PGliteがフォルダをロックします）。複数のプロセスで動かす場合は、[マルチノード](/docs/ja/guides/multi-node/)を参照してください。

## `createHub`のオプション

必須なのは`publicUrl`、`getUser`、`store`です。

| オプション | デフォルト | 役割 |
| --- | --- | --- |
| `publicUrl` | （必須） | ウェブサイトの公開オリジン。例：`https://app.example.com`。インストールとセットアップのコマンド、`/device`へのリンク、トランスポートのURL、CSRFのオリジンチェックに使われます。`https://`である必要があります（`http://`は`localhost`、`127.0.0.1`、`[::1]`の場合のみ可）。 |
| `getUser(req)` | （必須） | 認証処理。サインイン済みのブラウザまたはアプリ（`Authorization: Bearer …`、[ガイド](/docs/ja/guides/authenticate-apps/)）からのリクエストなら`{ id, name? }`、それ以外は`null`を返します。 |
| `trustedOrigins` | `[]` | クロスサイト保護を通す追加の正確なオリジン。たとえば`chrome-extension://<id>`（[ガイド](/docs/ja/guides/browser-extension/)）。ワイルドカードやパスは不可で、httpsと拡張機能のスキーム、またはlocalhostに限った`http`のみ。自分で管理しているオリジンだけにしてください。ネイティブアプリは`Origin`を送らないため不要です。CORSは追加されません。ハブはプリフライトに応答しないため、信頼された`https`オリジンが役に立つのは、フレームワーク側でCORSを追加した場合だけです。ホスト権限を持つ拡張機能はCORSを回避します。 |
| `onAttention(event, ctx)` | なし | 承認が要求されたとき、またはRunが完了・失敗したときに呼ばれ、プッシュ通知の送信に使います。イベントごとに最大1回で、10分より古いイベントでは呼ばれません。`expoPushNotifier`はすぐ使えるハンドラーです。[ガイド](/docs/ja/guides/push-notifications/) |
| `store` | （必須） | `HubStore`。Nodeプロセス1つなら`@uncage/hub/node`の`pgliteHubStore({ dataDir })`、複数ノードとFaaSなら`postgresHubStore({ connectionString } \| { pool })`。ハブがこれを閉じることはありません。 |
| `cluster` | `memoryCluster()` | `ClusterAdapter`。複数ノードとFaaSでは`redisCluster`または`postgresCluster`を使います。[ガイド](/docs/ja/guides/multi-node/) |
| `basePath` | `/api/uncage` | ハブのマウント先。変更した場合は、同じパスを`UncageProvider`の`baseUrl`に渡してください。 |
| `tools` | `[]` | `defineTool`で定義したサイトツール。[ガイド](/docs/ja/guides/define-tools/) |
| `skills` | `[]` | `SkillSpec[]`。[ガイド](/docs/ja/guides/write-skills/) |
| `selectManifest(ctx)` | すべてのツールとスキル | 実行ごとにツールとスキルを選びます。[ガイド](/docs/ja/guides/select-manifest/) |
| `sessionStorage` | `'machine'` | `'site'`にすると、すべての会話のレプリカを保持します。[ガイド](/docs/ja/guides/site-storage/) |
| `attachmentRetentionDays` | `30` | ウェブサイト経由で送られた添付ファイルのコピーをハブが保持する日数（`Infinity`で無期限に保持）。取り消されたコンピュータの添付ファイルは即座に削除されます。[詳細](/docs/ja/guides/site-storage/#添付ファイル) |
| `site` | `publicUrl`のホストから得たIDと名前 | ペアリング時にコンピュータに表示される`{ id?, name? }`。`id`は変えないでください。 |
| `verificationPath` | `/device` | 承認ページ。[ガイド](/docs/ja/guides/auth-and-device-approval/) |
| `minAgentVersion` | `0.3.0` | これより古いエージェントにはアップグレードを指示します（`upgrade_required`）。WebSocketの場合はエージェントが自分でアップグレードし、FaaS モードではウェブサイトに「Agent update needed」（エージェントの更新が必要）と表示されます。 |
| `cliVersionRange` | ハブの`^<major.minor>` | `install.sh` / `install.ps1`がインストールする`@uncage/cli`のバージョン（`^0.3`、`~0.3.1`、`0.3.0`、`latest`）。 |
| `installScript` | なし | インストーラーに追加する静的なテキスト。CLIのインストール後の手順や、独自の「エージェントが見つからない」場合の案内を追加できます。 |
| `transports` | `attachWebSocket`を使う場合は`['ws', 'http']`、それ以外は`['http']` | エージェントに提供するトランスポート。別のプロセスが`<basePath>/agent`でWebSocketを処理している場合は`ws`を含めます。WebSocketだけを提供するなら`http`を外します。 |
| `stream` | `{ maxDurationMs: 250000 }` | この時間が経過すると、ハブはエージェントのストリームとブラウザのイベントストリームを終了させ、クライアントは途切れることなくすぐに再接続します。プラットフォームのリクエストの制限時間より短くしてください。 |
| `polling` | `{ activeMs: 300, idleMs: 2000, activeWindowMs: 30000 }` | エージェントのHTTPストリームがアウトボックスをポーリングする頻度。アクティブな間は短い間隔で、静かになると`idleMs`まで間隔を広げます。 |
| `heartbeat` | `{ pingIntervalMs: 10000, missedPings: 2 }` | 応答のないコンピュータは約30秒後にオフライン表示になります。 |
| `sseHeartbeatMs` | `15000` | ブラウザのイベントストリームに送るキープアライブのコメントの間隔。 |
| `commandTimeoutMs` | `30000` | ブラウザのリクエストがコンピュータの応答を待つ時間。 |
| `bodyTimeoutMs` | `30000` | この時間バイトが1つも届かない場合、またはボディ全体の受信に、この時間の4倍を超える時間がかかった場合、リクエストボディは`400`で拒否されます。遅くても途切れずに続くアップロードは通ります。 |
| `logger` | コンソール | ハブが警告とエラーを報告する先（`{ warn(obj, msg), error(obj, msg) }`。pinoなど多くのロガーが使えます）。既定では`console.warn`と`console.error`で`[uncage] …`の行を出力します。`{ warn() {}, error() {} }`を渡すと出力しなくなります。VercelやWorkersでは、ハブに`cluster`がない場合（接続状況がインスタンスごとになります）、`toNextHandlers`と`fetchOnce`が警告を1回だけ出力します。[サーバーレスでのホスティング](#サーバーレスでのホスティングvercelnetlifyworkers)を参照してください。 |
| `toolTimeoutMs` | `120000` | この時間を過ぎても実行中のツールハンドラーは`tool_failed`で失敗します。FaaS モードでは、プラットフォームの制限時間内に収めてください。 |
| `toolDrainMs` | `5000` | `hub.close()`が実行中のツールハンドラーの完了を待つ時間。過ぎると中断します。 |
| `maxConcurrentToolCalls` | `8` | 1つのハブのインスタンス上で、1台のコンピュータが同時に実行できるツール呼び出しの数。 |
| `rateLimits` | 下記参照 | デバイスログインとマシントークンの不正利用対策の制限。 |
| `maintenance` | `{ intervalMs: 60000 }` | 保持期間を過ぎたデータの削除。下記参照。 |

`rateLimits`：`deviceCodesPerMinute`（クライアントIPごとに20）、`userCodeWindowMs`（10分）あたりの`userCodeFailures`（ユーザーごとにコード推測の失敗10回）、`agentAuthFailuresPerMinute`（マシントークンがない、または誤っているリクエストをクライアントIPごとに60回。有効なトークンが制限されることはありません）、`clientIp(req)`と`trustForwardedFor`（[プロキシの背後で](#リバースプロキシやロードバランサーの背後で)を参照）。制限を超えると`429 rate_limited`が返ります。カウントはストアに保存されるため、すべてのノードと関数インスタンスで共有されます。

`maintenance`は、不要になったものを削除し（応答のなかったRunのマニフェストは1時間後、それ以外は7日後。添付ファイルのコピーは`attachmentRetentionDays`の経過後。重複排除の行と保存されたツールの結果は24時間後。期限切れのアウトボックスの項目とデバイスコード）、ハンドラーの途中でインスタンスが停止したサイトツールの呼び出しを失敗として処理します。実行は全インスタンスを通じて`intervalMs`ごとに最大1回です。`attachWebSocket`を使っている場合はタイマーで、それ以外はリクエストがきっかけで実行されます（プラットフォームが`waitUntil`を提供していればレスポンスの後に実行します）。`secret`を指定すると、プラットフォームのcron用に、`Authorization: Bearer <secret>`付きの`GET|POST <basePath>/maintenance`が有効になります（Vercel Cronはこの方法で`CRON_SECRET`を送ります）。`onRun()`は、メンテナンスを実行するたびに独自の後始末を行います。

戻り値の`Hub`には、`basePath`、`fetch(req, info?)`、`approveDevice`、`denyDevice`、`lookupDevice`、`revokeMachine`、`maintain()`、`close()`があります。`info`は`{ clientIp?, waitUntil? }`です。`close()`はストアを閉じることはなく、クラスターもハブ自身が作成した場合にだけ閉じます。自分で作成したものは、その後で閉じてください。

## リバースプロキシやロードバランサーの背後で

:::caution[本番公開の前にクライアントIPを設定する]
`POST <basePath>/device/code`（`uncage setup`のたびに呼ばれます）には、**クライアントIPごとに1分あたり20回**の制限があります。リバースプロキシ、ロードバランサー、CDNの背後では、設定しない限りハブにはユーザーではなくプロキシのアドレスが見えます。すると**全ユーザーが1つのレート制限の枠を共有する**ことになり、サイト全体で1分間に21回目のセットアップから、`uncage setup`が`429 rate_limited`で失敗します。

次のいずれかで解決してください。

- Express：`app.set('trust proxy', 1)`（アプリの前段にあるプロキシの数）。これで`toNodeHandler`が`req.ip`を渡します。
- VercelのNext.js：何もする必要はありません。`toNextHandlers`がVercelのエッジが設定するアドレスを読み取ります。Cloudflare Workers：`fetchOnce`に`clientIp: req.headers.get('cf-connecting-ip') ?? undefined`を渡します。
- どのサーバーでも：`rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined }`（利用しているプラットフォームのクライアントIPヘッダーを使います）。
- `rateLimits: { trustForwardedFor: true }`。プロキシがクライアントのアドレスを`X-Forwarded-For`に追記する場合に限ります（ハブは一番右のエントリーを使います）。
:::

- `<basePath>/agent`の**WebSocketのアップグレードを転送し**（nginx：`proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`）、長時間の接続を許可してください（ハブは10秒ごとにpingを送ります）。アップグレードに失敗した場合、エージェントは自動的にHTTPストリーミングにフォールバックしますが、WebSocketのほうが高速です。
- **元の`Host`を維持します**（nginx：`proxy_set_header Host $host;`）。ハブはリクエストの`Origin`を`publicUrl`および`Host`と比較し、クロスサイトのPOSTを拒否します。
- **ストリームはバッファリングしません**。対象は`<basePath>/sessions/*/events`のSSEと`<basePath>/agent/stream`のNDJSONです（nginx：`proxy_buffering off;`）。少なくとも`stream.maxDurationMs`（250秒）の長さのリクエストを許可してください。
- **レート制限のためのクライアントIP**。Expressでは`app.set('trust proxy', 1)`を設定すれば、`toNodeHandler`が`req.ip`を使います。Fetchスタイルのサーバーでは、`hub.fetch(req, { clientIp })`を渡すか、`rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined }`（またはプラットフォームのヘッダー）を渡すか、プロキシがクライアントのアドレスを`X-Forwarded-For`に追記するなら`trustForwardedFor: true`を指定します。どれも設定しないと、すべてのクライアントがプロキシのアドレス（または`shared`という1つの枠）としてカウントされ、制限が全ユーザー合計にかかります。
- **TLS**。どこで終端してもかまいませんが、`publicUrl`はユーザーが開く`https://`のURLでなければなりません。エージェントは、`localhost`と`127.0.0.1`以外への平文の`http://`接続を拒否します。

## サーバーレスでのホスティング（Vercel、Netlify、Workers）

サーバーレス関数はWebSocketを保持できませんが、その必要もありません。FaaS モードでは、ハブは関数の中で動き、状態をPostgresに保存し、コンピュータはHTTPストリーミングで接続します。プラットフォームに合ったページに従ってください。

- [VercelでNext.js](/docs/ja/deploy/vercel/)：`app/api/uncage/[...path]/route.ts`で`toNextHandlers(getHub, { waitUntil: after })`を使います。
- [Cloudflare Workers](/docs/ja/deploy/cloudflare-workers/)：`fetchOnce`が、Hyperdriveのプールの上にリクエストごとにハブを作成します。
- [その他のFetch対応プラットフォーム](/docs/ja/deploy/other-fetch-platforms/)：`hub.fetch(req, { clientIp, waitUntil })`を使います。

サーバーレスのサイトの横で従来モードを使い続けたい場合は、上のいずれかのサーバーを、同一オリジンの独立したサービスとして動かしてください。[Node → FAQ](/docs/ja/deploy/node/#サイトはvercelやnetlifyにありますそれでも従来モードを使えますか)を参照してください。
