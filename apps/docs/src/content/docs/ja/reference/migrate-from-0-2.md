---
title: 0.2からの移行
description: Uncage 0.3のすべての破壊的変更を、変更前後のコードとともに説明します。@uncage/hubはWeb標準になり、Node固有の部分は@uncage/hub/nodeに移動し、storeは必須になり、hub.handlerとhub.attachはhub.fetchとattachWebSocketに置き換わり、エージェントは0.3以降が必要になりました。新しいオプションとHubStoreへの追加も掲載しています。
---

Uncage 0.3では、ハブがプラットフォームに依存しなくなりました。同じハブが、Nodeプロセス（従来モード）でも、サーバーレスやFetch対応プラットフォーム（FaaS モード）でも動きます。[デプロイモードを選ぶ](/docs/ja/start/choose-deployment-mode/)を参照してください。0.2との互換レイヤーはないため、0.2のウェブサイトには以下の小さな変更が必要です。依存しているすべての`@uncage/*`パッケージをまとめて0.3に更新してください（バージョンは共通です。使っている場合は`@uncage/server`、`@uncage/core`、`@uncage/agent`、各ランタイムも含みます。`@uncage/cli`はユーザーが各自で更新します）。

```sh
npm i @uncage/hub@^0.3 @uncage/react-ui@^0.3 @uncage/react@^0.3 @uncage/client@^0.3 @uncage/protocol@^0.3 # every @uncage/* package you use, together
```

## 従来モードのサーバー：変更前と変更後

ほとんどの0.2のサイトで必要な変更は、これだけです。

```ts nocheck
// 0.2
import { createHub, toNodeHandler } from '@uncage/hub';

const hub = await createHub({ publicUrl, getUser });
app.use(toNodeHandler(hub));
const server = createServer(app);
hub.attach(server);
```

```ts title="server.ts"
// 0.3
import { createServer } from 'node:http';
import { createHub, type HubUser } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import express from 'express';

declare function getUser(req: Request): Promise<HubUser | null>;

const store = await pgliteHubStore({ dataDir: './.uncage-hub' }); // the folder 0.2 used by default
const hub = await createHub({ publicUrl: 'https://app.example.com', getUser, store });
const app = express();
app.use(toNodeHandler(hub));
const server = createServer(app);
attachWebSocket(hub, server);
server.listen(3000);
```

`dataDir: './.uncage-hub'`（または使っていたフォルダ）をそのまま指定すれば、ペアリング済みのコンピュータ、セッション、レプリカは引き継がれます。ストアは起動時に新しいマイグレーションを実行します。

## 破壊的変更

### `@uncage/hub`のルートはWeb標準になり、Node固有の部分は`@uncage/hub/node`に移動

ルートのエントリはWeb APIだけを使うため、Workers、Vercel、その他のFetch対応プラットフォーム向けにバンドルできます。Node専用の部分は次のように移動しました。

| 0.2（`@uncage/hub`） | 0.3 |
| --- | --- |
| `toNodeHandler(hub)` | **`@uncage/hub/node`の**`toNodeHandler(hub)` |
| `hub.attach(server, { path? })` | **`@uncage/hub/node`の**`attachWebSocket(hub, server, { path? })`。`detach()`関数を返します。`hub.close()`でもデタッチされます。1つのハブに同時に割り当てられるサーバーは1つです。 |
| `pgliteHubStore({ dataDir })` | **`@uncage/hub/node`の**`pgliteHubStore({ dataDir })` |

それ以外（`createHub`、`defineTool`、`postgresHubStore`、`redisCluster`、型）は引き続き`@uncage/hub`にあります。

### `createHub`で`store`が必須に

0.2では、`store`を省略すると`pgliteHubStore({ dataDir: './.uncage-hub' })`が自動で作成されていました。0.3では`createHub: store is required`というエラーになります。`pgliteHubStore(…)`（Nodeプロセス1つの場合）か`postgresHubStore(…)`（複数ノード、FaaSの場合）を渡してください。

### `hub.handler` → `hub.fetch`

`hub.handler(req, info?)`は`hub.fetch(req, info?)`になりました。`info`には`waitUntil(promise)`が追加されました。これは、レスポンスより長く続く可能性のある処理のためのプラットフォームのフックです（Workersの`ctx.waitUntil`、Next.jsの`after`）。

### `hub.close()`はストアを閉じない

0.2では、ハブが作成したストアは`hub.close()`で閉じられていました。0.3では`store`は常にアプリ側のものであり、ハブが閉じることはありません。`await hub.close()`の後に`await store.close()`を呼び出してください。クラスターは従来どおり、ハブが作成した場合（`cluster`オプションを指定しなかった場合）にだけ閉じられます。また、`hub.close()`は実行中のサイトツールのハンドラーに、完了までの猶予として`toolDrainMs`（5秒）を与えるようになりました。

### エージェントは0.3以降が必要

Connected モードのプロトコルはバージョン2になり、`minAgentVersion`のデフォルトは`0.3.0`になりました。

- **従来モード**：WebSocketで接続した0.2のエージェントには`upgrade_required`が返ります。0.2のエージェントは自動的にアップグレード（`npm i -g @uncage/cli@latest`）して再接続します。
- **FaaS モード**：0.2のエージェントはWebSocketしか知りませんが、FaaSのハブはWebSocketを提供しません。エージェントには`426 upgrade_required`が返り、ハブはそのコンピュータを「古い」と記録し、ウェブサイトには実行すべきコマンド（`npm i -g @uncage/cli@latest`の後に`uncage setup <url>`）とともに**Agent update needed**（エージェントの更新が必要）と表示されます。`<AgentChat>`はこれを自動的に表示します（`<AgentOutdatedNotice>`、`MachineInfo.agentOutdated`）。

ハブが配信する`install.sh`は、デフォルトで`@uncage/cli@^0.3`をインストールします。

### `@uncage/server/wire`はNodeハンドラーをエクスポートしなくなった

Fetch → Nodeのアダプターは専用のサブパスに移動しました：`import { toNodeHandler } from '@uncage/server/node-handler'`。これを使っていたのは、独自のNodeアダプターを作っていた場合だけです。Local モードのプロキシ（`@uncage/server/proxy`）は変わっていません。

### `UncageError`は`@uncage/core/errors`から

`@uncage/core/errors`は、エラー関連のヘルパー（`UncageError`）だけを含む新しいサブパスです。`@uncage/core`の他の部分（Node APIを読み込みます）は含みません。Web標準のバンドルで動くコード（Worker、またはWorkerと共有するサイトツール）は、ここからインポートしてください。`@uncage/core`からも引き続きエクスポートされています。

### `fetchOnce`と`toNextHandlers`（新規）

破壊的変更ではありませんが、ルートのエントリに新しいマウント用ヘルパーが追加されました。`toNextHandlers(hub | promise | getter, { clientIp?, waitUntil? })`は、Next.jsのルートハンドラー用に`{ GET, POST, PATCH, DELETE }`を返します。`fetchOnce(create, req, { clientIp?, waitUntil? })`は、ソケットを共有できない環境（Workers）でリクエストごとにハブを作成します。`create(defer)`はハブか`{ hub, close }`を返します。[VercelでNext.js](/docs/ja/deploy/vercel/)と[Cloudflare Workers](/docs/ja/deploy/cloudflare-workers/)を参照してください。

### レート制限はストアでカウント

デバイスコード、コードの入力失敗、そして新しく追加されたマシントークンの認証失敗の制限は、ストアでカウントされるようになり、すべてのノードと関数インスタンスで共有されます（0.2ではノードごとにカウントしていました）。独自の`HubStore`を実装していない限り（後述）、変更は不要です。FaaS モードでは、ハブにクライアントIPを渡してください。渡さないと、すべての呼び出し元が1つの枠を共有することになります（ハブは一度だけ警告をログに出します）。Vercelでは`toNextHandlers`がこれを行い、`fetchOnce`は`clientIp`を受け取ります。

### `HubStore`にメソッドが追加

独自の`HubStore`を作っている場合にだけ関係します（組み込みの`pgliteHubStore`、`postgresHubStore`、`sqlHubStore`は対応済みです）。新しく追加されたのは、コンピュータごとの**リンク**（`openLink`、`pollLink`、`updateLink`、`closeLink`）、永続的な**アウトボックス**（`enqueueOutbox`）、重複排除のための上り方向の**インボックス**（`claimInbox`、`completeInbox`、`releaseInbox`）、**ツール呼び出しの状態**（`claimToolCall`、`finishToolCall`、`getToolCall`、`listStaleToolCalls`、`pruneToolCallResults`）、**共有カウンター**（`hitRateLimit`、`releaseRateLimit`）、**メンテナンスのリース**（`tryLease`）、保持期間の管理（`pruneTransport`）、そして`markMachineOutdated`と`recordDevicePoll`です。変更点として、`finishToolCall(id, finish)`は結果も受け取るようになり（`ToolCallFinish & { result }`）、`boolean`を返すようになりました（この呼び出しの完了処理が採用されたかどうか。以前は`void`でした）。`MachineRecord`には任意のフィールド`outdatedAt`が追加されました。SQLのストアは起動時に新しいマイグレーションを適用します。Postgresではマイグレーションがトランザクション単位のアドバイザリーロックを取るため、PgBouncerやNeonの`-pooler`の背後でも動作します。

### `hub.maintain()`（新規）

`hub.maintain()`はメンテナンスをその場で実行し（別のインスタンスがリースを持っている場合を除く）、`{ ran, pruned, interruptedToolCalls }`を返します。通常は必要ありません。`attachWebSocket`がタイマーで実行し、FaaS モードではリクエストや`GET <basePath>/maintenance`がきっかけで実行されます。WorkersのCron Triggerからは、`scheduled`の中でこれを呼び出せます。

### `ClusterAdapter.refreshPresence`（任意）

独自のクラスターアダプターでは、`refreshPresence(machineId, nodeId, ttlSec): Promise<boolean>`を実装できます（プレゼンスが存在しないか、すでに自ノードのものである場合にだけ、アトミックに設定します）。実装しない場合、ハブは「確認してから設定する」方式にフォールバックします。`memoryCluster`、`redisCluster`、新しい`postgresCluster`は実装済みです。

### 通信とAPIの形式

- `MachineInfo`に2つのフィールドが追加されました：`agentOutdated`（boolean）と`transport`（`'ws' | 'http' | null`）。
- `GET /machines/install`は、`windows`にWindows用のコマンド（`irm https://<site>/api/uncage/install.ps1 | iex`）を返すようになりました（以前は`null`）。ハブは`install.ps1`も配信します。
- デバイストークンのレスポンスには、提供されるトランスポートが含まれます。`GET <basePath>/agent/info`（公開）も同様です。
- エージェントのプロトコルの独自クライアントについては、[HTTP API → エージェントのトランスポート](/docs/ja/reference/http-api/#エージェントのトランスポートhttpストリーミング)を参照してください。

## 新しいオプション

すべて任意です。詳しい説明は[ハブをマウントする → オプション](/docs/ja/guides/mount-the-hub/#createhubのオプション)を参照してください。

| オプション | デフォルト | 内容 |
| --- | --- | --- |
| `transports` | `attachWebSocket`を使う場合は`['ws', 'http']`、それ以外は`['http']` | エージェントに提供するトランスポート。 |
| `stream.maxDurationMs` | `250000` | この時間が経過すると、ハブはエージェントのストリーム**とブラウザのイベントストリーム**を終了させます。クライアントは途切れることなくすぐに再接続します。プラットフォームのリクエストの制限時間より短くしてください。 |
| `polling` | `{ activeMs: 300, idleMs: 2000, activeWindowMs: 30000 }` | エージェントのHTTPストリームがアウトボックスをポーリングする頻度。 |
| `rateLimits.agentAuthFailuresPerMinute` | `60` | マシントークンがない、または誤っている`/agent/*`へのリクエストの上限（クライアントIPごと）。 |
| `maintenance` | `{ intervalMs: 60000 }` | 保持期間を過ぎたデータの削除と、停止したインスタンスのツール呼び出しを失敗として処理すること。全インスタンスを通じて間隔ごとに最大1回実行します。`secret`を指定すると`GET\|POST <basePath>/maintenance`が有効になります（Vercel Cron用）。`onRun`で独自の後始末を追加できます。 |
| `bodyTimeoutMs` | `30000` | この時間バイトが1つも届かない場合、またはボディ全体の受信にこの時間の4倍を超える時間がかかった場合、リクエストボディは`400`で拒否されます。 |
| `logger` | コンソール | ハブが警告とエラーを報告する先。`{ warn() {}, error() {} }`を渡すと出力しなくなります。 |
| `toolDrainMs` | `5000` | `hub.close()`が実行中のサイトツールのハンドラーの完了を待つ時間。 |
| `installScript` | なし | `install.sh` / `install.ps1`に追加する静的な手順。 |
| `postgresCluster({ pool \| connectionString })` | | Postgres上の`ClusterAdapter`。複数ノードやFaaSでもRedisが不要になります。 |

メンテナンスによる保持期間の管理：一度も応答されなかったRunのマニフェストは1時間、それ以外は7日間。ハブ上の添付ファイルのコピーは`attachmentRetentionDays`（30日）。重複排除の行は24時間。保存されたツールの結果は、呼び出しの完了から24時間。アウトボックスの項目は有効期限まで。デバイスコードは有効期限の1時間後まで。従来モードでは`attachWebSocket`が毎分実行し、FaaS モードではリクエストがきっかけで実行されます。

## 知っておくべき動作の変更

- **サイトツールの呼び出しは接続が切れても失われません**。呼び出しとその結果が保存されるため、エージェントが再試行すると、2回目の実行ではなく保存済みの結果を受け取ります（ちょうど1回。FaaSプラットフォームでは、ハブにプラットフォームの`waitUntil`を渡した場合。[Workers → FAQ](/docs/ja/deploy/cloudflare-workers/#workersでサイトツールはちょうど1回実行されますか)を参照）。ハンドラーを実行中のインスタンスが停止した場合、呼び出しは「Site tool "<name>" timed out on the website. Please try again.」というエラーで失敗し、再実行されることはありません（最大1回）。`ctx.signal`は、タイムアウト時、Runの終了時、ハブを閉じたときに中断されますが、コンピュータの接続が切れたときには中断されなくなりました。詳しくは[ツールを定義する](/docs/ja/guides/define-tools/#接続が切れたときインスタンスが停止したとき)を参照してください。
- **ブラウザのイベントストリームは、`stream.maxDurationMs`ごとに開き直されます**（`event: reconnect`フレーム）。`@uncage/client`は`Last-Event-ID`を使って自動的に再開します。独自のSSEクライアントは、このフレームを受け取ったら再接続してください。
- **WebSocketが失敗した場合（3回失敗した場合）、コンピュータはHTTPストリーミングで接続できます**。その後、30分ごとにWebSocketを再試行します。
- **ハブがコンソールにログを出力するようになりました。** 0.2のハブは何も出力しませんでした。0.3は警告とエラー（先頭に`[uncage]`が付きます）を`console.warn`と`console.error`で出力します。対象は、500で失敗したリクエスト、メンテナンスの失敗、IPごとの制限に使うクライアントIPが取れない場合、そしてFaaSでハブに`cluster`がない場合の1回限りの警告です。新しい`logger`オプションに独自のロガーを渡すか、`{ warn() {}, error() {} }`を渡すと出力しなくなります。
- **ACPエージェントは既定で検出・起動されます。** `uncage serve`、`uncage doctor`、`uncage agent`は、コマンドがPATH上にあるACPプリセットを登録し、インストール済みのエージェントをACPレジストリから検出するようになりました（`presets: auto`、`autoDetect: true`）。起動のたびに、これらのプログラム（例：`opencode acp`）をACPの`initialize`ハンドシェイクのために1回実行します。無効にするには、`~/.uncage/agent.yaml`（Localモードでは`uncage.config.yaml`）で`runtimes.acp.autoDetect: false`（検出もハンドシェイクもしない）と`presets: off`を設定します。[任意のACPエージェントを使う](/docs/ja/guides/use-any-acp-agent/)を参照してください。
- **レジストリを1日1回ダウンロードします。** エージェントは、ACPレジストリとそのアイコンを`cdn.agentclientprotocol.com`から最大で1日1回ダウンロードします。無効にするには、エージェントの環境で`UNCAGE_ACP_REGISTRY_REFRESH=0`を設定します（Uncageに同梱のコピーを使います）。
- **新しいランタイムIDと新しい`skills`の値。** ランタイム一覧に`acp-*`ランタイム（`acp-claude`、`acp-gemini`など）が含まれることがあり、`RuntimeCapabilities.skills`は0.2の値に加えて`'prompt'`（スキルを`.uncage/skills/`に書き出し、最初のプロンプトで一覧にする）になることがあります。ランタイムIDや`skills`の値で分岐するカスタムUIは、どちらにも対応してください。
- **共有データベースに対して0.3を実行する前に、0.2のハブノードをすべて停止してください。** 0.3のマイグレーションはツール呼び出し（`machine_id`、`call_id`）にユニークインデックスを追加します。同じデータベースに書き込み続ける0.2のノードはこれに違反し、ツール呼び出しが失敗します。0.2のノードをすべて停止してから0.3を起動し（最初のノードがマイグレーションを実行します）、残りのノードを起動してください。0.2と0.3を混在させたローリングアップグレードはできません。
- **`<ConnectMachine>`はコマンドを1つだけ表示します**。サイトのインストーラーを「macOS / Linux」と「Windows」のタブで表示し、最初は訪問者のOSのタブが開きます（`install.windows`も表示されるようになりました）。`uncage setup <url>`は「Already have the CLI?」（CLIをインストール済みの場合）の下にあります。番号付きの2ステップのリスト（`ol.uc-connect-steps`、`.uc-connect-num`）はなくなりました。これらを対象にしたCSSがあれば更新してください。

## チェックリスト

- [ ] すべての`@uncage/*`パッケージが0.3になっている。
- [ ] `toNodeHandler`、`attachWebSocket`、`pgliteHubStore`を`@uncage/hub/node`からインポートしている。`hub.attach`と`hub.handler`を使っていない。
- [ ] `createHub`に`store`を渡し、`hub.close()`の後にそれを閉じている。
- [ ] `pnpm build` / `tsc`が通る。
- [ ] `curl -s https://your.site/api/uncage/agent/info`に`"protocol":2`が含まれる。
- [ ] 0.2のエージェントを使っているユーザー：エージェントが自動的にアップグレードする（従来モード）か、ユーザーが**Agent update needed**の通知に従う（FaaS モード）。
