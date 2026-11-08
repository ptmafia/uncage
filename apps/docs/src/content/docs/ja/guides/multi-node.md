---
title: マルチノード（Redis + Postgres）
description: postgresHubStoreとredisClusterを使い、ロードバランサーの背後で2台以上のノードにハブを実行する方法。ノード間でやり取りされるもの、ロードバランサーの設定、ローカルでの試し方を説明します。
---

多くのデプロイでは、ハブのノードは1台で十分です。可用性、ローリングデプロイ、接続数の増加などでそれ以上が必要になったら、同じハブを複数のノードで動かし、ロードバランサーの背後に置きます。スティッキーセッションは不要です。

## 何が変わるか

コンピュータのWebSocketは1台のノード（A）上にあります。ブラウザのリクエストはどのノード（B）に届いてもかまいません。これを成り立たせるのが、2つの共有コンポーネントです。

| | 1ノード（デフォルト） | 複数ノード |
| --- | --- | --- |
| `store`（`HubStore`） | `pgliteHubStore({ dataDir })`：組み込みPostgres。データフォルダごとに1プロセス | `postgresHubStore({ connectionString })`または`({ pool })`。`pg`が必要です。 |
| `cluster`（`ClusterAdapter`） | `memoryCluster()`：プロセス内 | `redisCluster({ url })`または`({ client })`。`ioredis`が必要です。 |

```mermaid
flowchart LR
  B["Browser"] --> LB["Load balancer"]
  M["User's computer"] -- "WSS" --> LB
  LB --> N1["Hub node A<br/>holds the computer's socket"]
  LB --> N2["Hub node B<br/>serves the browser request"]
  N1 <-- "presence, commands,<br/>results, events" --> R[("Redis")]
  N2 <--> R
  N1 --> P[("Postgres")]
  N2 --> P
```

- Bは、どのノードがコンピュータの接続を持っているかを調べ（Redis上のプレゼンス情報）、Aのチャネルにコマンドを発行します。Aはそれをコンピュータに転送し、結果を発行し返します。
- セッションのイベントはRedisのPub/Subですべてのノードに配信されるため、どのノードからストリーミングしているブラウザでもイベントを受け取れます。
- サイトツールの呼び出しは、コンピュータの接続を持つノードAで実行されます。
- Bで判定された承認は、コンピュータにちょうど1回だけ届きます。判定を下すのはコンピュータだけです。2つの判定が競合した場合、後のものは`409`になります。

## セットアップ

```sh
npm i pg ioredis
```

```ts title="hub.ts"
import { createHub, postgresHubStore, redisCluster, type HubUser } from '@uncage/hub';

declare function getUser(req: Request): Promise<HubUser | null>;

const store = await postgresHubStore({ connectionString: process.env.DATABASE_URL! });
const cluster = redisCluster({ url: process.env.REDIS_URL! });

export const hub = await createHub({
  publicUrl: 'https://app.example.com', // the same on every node
  getUser,
  store,
  cluster,
  sessionStorage: 'site',
});

/** On shutdown: the hub closes only what it created, so close the store and cluster after it. */
export async function closeHub(): Promise<void> {
  await hub.close();
  await cluster.close();
  await store.close();
}
```

サーバーへのマウント方法は1ノードの場合とまったく同じです（[ハブをマウントする](/docs/ja/guides/mount-the-hub/)）。

- **マイグレーション**はストアの起動時に実行されます。Postgresではアドバイザリーロックの下で実行されるため、複数のノードを同時に起動できます。
- **すべてのノードで同じ設定が必要です**：`publicUrl`、`basePath`、`site`、`tools`、`skills`、`selectManifest`、`sessionStorage`。ツール呼び出しはコンピュータのソケットを持つノードで実行されるため、すべてのノードにすべてのツールが必要です。
- **複数のデプロイ（たとえばステージングと本番）で1つのRedisを共有する**場合は、`keyPrefix`を変えます：`redisCluster({ url, keyPrefix: 'myapp-staging:' })`。デフォルトは`uncage:`です。これはプレゼンスのキーとPub/Subのチャネルの両方の接頭辞になります。

### 独自のプールやクライアントを使う

```ts title="own-clients.ts"
import { postgresHubStore, redisCluster } from '@uncage/hub';
import { Redis } from 'ioredis';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
pool.on('error', (err) => console.error('postgres pool error', err)); // required: see below
const redis = new Redis(process.env.REDIS_URL!);
redis.on('error', (err) => console.error('redis error', err));

export const store = await postgresHubStore({ pool });
export const cluster = redisCluster({ client: redis, keyPrefix: 'myapp:' });
```

node-postgresは、アイドル状態の接続が切れたとき（データベースの再起動やフェイルオーバー）にプールで`'error'`を発行します。リスナーがないと、プロセスがクラッシュします。ハブ自身が作成したプールやクライアント（`{ connectionString }`、`{ url }`）には、ログを出力するリスナーが付きます（`onError`オプション、デフォルトは`console.error`）。**独自の`pool`や`client`を渡す場合は、自分で`'error'`リスナーを付けてください。**

## ロードバランサー

- `<basePath>/agent`の**WebSocket**は転送されなければなりません（HTTP/1.1の`Upgrade`）。アイドルタイムアウトは10秒のハートビートより長くしてください。スティッキーセッションは不要です。
- `<basePath>/sessions/:id/events`の**SSE**はバッファリングしてはいけません。アイドルタイムアウトは15秒（SSEのハートビート）より長くする必要があります。
- **Hostヘッダー**を維持し、レート制限のために**クライアントIP**を引き渡してください。[プロキシの背後での設定](/docs/ja/guides/mount-the-hub/#リバースプロキシやロードバランサーの背後で)を参照してください。
- **ドレイン**：デプロイ時は、ノードへの新しいリクエストの送信を止めてから`close()`します。そのノードにつながっていたコンピュータは、指数バックオフ（1秒から最大30秒まで増加）で別のノードに再接続します。その間も実行はローカルで続き、イベントは再接続時に補完されます。

:::caution[ロードバランサーの背後でのクライアントIP]
`POST <basePath>/device/code`には、ノードごと・**クライアントIPごと**に1分あたり20回の制限があります。ロードバランサーの背後では、`app.set('trust proxy', <hops>)`（Expressで`toNodeHandler`を使う場合）、`rateLimits.clientIp(req)`、`rateLimits.trustForwardedFor: true`のいずれかを設定しない限り、すべてのリクエストがロードバランサーのアドレスから来たものとして扱われます。どれも設定しないと、全ユーザーがノードごとに1つのバケットを共有することになり、同じ1分間に20人ほどが接続した時点で`uncage setup`が`429 rate_limited`で失敗し始めます。
:::

## 知っておくべき制限

- レート制限（IPごとのデバイスコード発行、ユーザーごとのコード推測の失敗）は**ノードごと**にカウントされ、共有されません。IPごとの制限には実際のクライアントIPが必要です（上の注意を参照）。
- `pgliteHubStore`はデータフォルダをロックするため、複数のプロセスで共有できません。複数のノードではPostgresを使う必要があります。

## ローカルで試す

リファレンスデモには、前段に小さなラウンドロビンのプロキシ（スティッキーなし）を置いた2ノードモードがあります。そのため、コンピュータとブラウザは通常、別々のノードにつながります。

```sh
cd examples/connected-demo
docker compose up -d                # redis:7-alpine on 127.0.0.1:6380, postgres:16-alpine on 127.0.0.1:5433
pnpm build
HUB_NODES=2 REDIS_URL=redis://127.0.0.1:6380 \
  DATABASE_URL=postgres://uncage:uncage@127.0.0.1:5433/uncage pnpm multinode
# proxy on :3200, nodes on :3201 and :3202
docker compose down                 # when done
```

続いて、[クイックスタート](/docs/ja/start/quickstart-connected/#9-コンピュータを接続するユーザー側)と同じ手順で、`http://localhost:3200`に対してコンピュータを接続し、タスクを実行します。E2Eテストスイートもこの構成で実行され（`e2e/`から`UNCAGE_DOCKER_TESTS=1 pnpm exec playwright test --project=connected-multinode`）、両方のノードが応答したことを確認します。

ハブ自体のテストも、同じ2ノードのシナリオを`ioredis-mock`を使って1プロセス内で実行します（`pnpm --filter @uncage/hub test`）。`UNCAGE_DOCKER_TESTS=1`を指定すると、実際のRedisとPostgresのコンテナに対しても実行します。
