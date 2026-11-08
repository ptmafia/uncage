---
title: トラブルシューティング
description: Connected モード（コンピュータが接続しない、オフラインになる、エージェントの更新が必要、セットアップのエラー、ツールが呼ばれない、サーバーレスでの504とタイムアウト、接続の切断、プーラー、プロキシの背後のWebSocket）とLocal モード（デーモンに到達できない、forbidden_origin、ポート、サインイン）でよくある問題の解決方法。
---

## Connected モード

### `uncage setup`が失敗する、または終わらない

- **「Refusing plain http for …」**：エージェントが`http://`を受け付けるのは、`localhost`、`127.0.0.1`、`[::1]`の場合だけです。サイトの`https://`のURLを使ってください。
- **リンクは開くがApprove（承認）ボタンがない**：コードが未知、使用済み、または10分以上前のものです。`uncage setup <url>`をもう一度実行してください。`/device`ページがクエリパラメーターの`code`を`hub.lookupDevice`に渡しているかも確認してください。
- **「Too many requests」 / `rate_limited`**：1つのIPからのコードが多すぎる（1分あたり20）か、1人のユーザーによる間違ったコードが多すぎます（10分あたり10）。多くのユーザーで同時に起きる場合は、次のセクションを参照してください。
- **そのコンピュータにブラウザがない**：`uncage setup <url> --no-browser`でリンクとコードが表示されます。ユーザーがサインインしている任意のデバイスでリンクを開いてください。
- **`UNCAGE_HOME is for foreground runs`**：`UNCAGE_HOME`を設定している場合は、`--no-daemon`を付け、`uncage agent`を自分で実行してください。

### 多くのユーザーで同時に`uncage setup`が`429 rate_limited`で失敗する

デバイスコードの制限（1分あたり20）は**クライアントIPごと**です。リバースプロキシ、ロードバランサー、CDNの背後では、クライアントIPを設定しない限りハブにはプロキシのアドレスが見えます。そのため全ユーザーが同じバケットに入り、1分間に21回目のセットアップから全員が失敗します。

- **Express**：`app.set('trust proxy', 1)`（前段にあるプロキシの数）を設定し、`req.ip`を渡す`toNodeHandler(hub)`でハブをマウントします。
- **VercelのNext.js**：`toNextHandlers`がVercelの`x-real-ip`を自動的に読み取ります。Vercelの前段に別のプロキシがある場合は、`clientIp`オプションを渡してください。
- **Cloudflare Workers**：`fetchOnce`に`clientIp: req.headers.get('cf-connecting-ip') ?? undefined`を渡します。
- **その他のFetchスタイルのサーバー（Honoなど）**：プラットフォームのクライアントIPヘッダーを使って`createHub({ rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined } })`とするか、`hub.fetch(req, { clientIp })`を渡します。
- **`rateLimits.trustForwardedFor: true`**：プロキシがクライアントのアドレスを`X-Forwarded-For`に追記する場合に限って使います。

カウントはストアに保存され、すべてのノードと関数インスタンスで共有されます。詳細は[プロキシの背後で](/docs/ja/guides/mount-the-hub/#リバースプロキシやロードバランサーの背後で)を参照してください。

### ページに「Waiting for your computer…」が表示され続ける

1. コンピュータ上で`uncage sites`を実行し、サイトが`active`として表示されることを確認します。
2. エージェントは動いていますか？`uncage agent status`で、バックグラウンドサービスと、それが使っているNode.jsを確認できます。または、サービスを停止して（`uncage agent uninstall`）ターミナルで`uncage agent`を実行し、出力を確認します。ログは`~/.uncage/logs/agent.log`と`agent.err.log`にあります。
3. ハブは何を提供していますか？`curl -s https://your.site/api/uncage/agent/info`が、`"transports"`を含むJSONを返す必要があります。HTMLのページや404が返る場合は、そのパスにハブがマウントされていません。
4. 従来モードの場合：サーバーは、`publicUrl`を配信しているのと同じHTTPサーバーで`attachWebSocket(hub, server)`を呼ぶ必要があります。また、前段のすべてのプロキシが`<basePath>/agent`のWebSocketのアップグレードを転送する必要があります（アップグレードに失敗しても、エージェントは3回試した後にHTTPストリーミングに切り替えるため、WebSocketが遮断されているだけでコンピュータがオフラインのままになることはなくなりました）。
5. FaaS モードの場合：エージェントが0.3以降である必要があり（[エージェントの更新が必要](#エージェントの更新が必要426-upgrade_required)を参照）、プラットフォームがレスポンスをストリーミングできる必要があります（[ストリームが切れる](#コンピュータが再接続を繰り返すまたはストリームが切れる)を参照）。
6. `publicUrl`はユーザーが開くURLでなければなりません。インストールとセットアップのコマンド、およびエージェントが使うトランスポートのURLは、この値から作られます。

### エージェントは動いているのにコンピュータがオフラインと表示される

- ノートパソコンがスリープした、またはネットワークが変わった：エージェントはバックオフ（1秒から最大30秒）しながら再接続します。実行はローカルで続き、イベントは再接続時に補完されます。
- ロードバランサーのアイドルタイムアウトが約30秒未満だと、WebSocketが切断されます。タイムアウトを延ばしてください。ハブは10秒ごとにpingを送ります。
- `uncage agent status`に、サービスのインストール時に使ったNode.jsが見つからないと表示される（Homebrewでのアップグレードや、nvm/fnmのバージョンの削除による）：`uncage agent install`をもう一度実行してください。
- コンピュータがサイトから取り消された：`uncage sites`に`revoked`と表示されます。`uncage setup <url>`をもう一度実行してください。
- エージェントが古すぎる：次のセクションを参照してください。

### エージェントの更新が必要（426 `upgrade_required`）

ハブにはエージェント0.3以降が必要です（`minAgentVersion`）。

- **従来モード（WebSocket）**：ハブがエージェントに`upgrade_required`を伝え、エージェントは`npm i -g @uncage/cli@latest`で自分をアップグレードしてから再接続します。そのコンピュータでnpmに`sudo`が必要な場合、アップグレードは失敗します。npmのグローバルプレフィックスを修正し（`npm config set prefix ~/.npm-global`を実行して、その`bin`を`PATH`に追加）、再インストールしてください。サイトのインストールコマンドを再実行すれば、これを代わりに行ってくれます。
- **FaaS モード（Vercel、Workersなど）**：0.2のエージェントはWebSocketしか話せませんが、FaaSのハブはWebSocketを提供しません。エージェントには`426 upgrade_required`が返り、ハブはそのコンピュータを「古い」と記録し、ウェブサイトにはそのコンピュータのカードとチャットに**Agent update needed**（エージェントの更新が必要）と表示されます（`<AgentOutdatedNotice>`、`MachineInfo.agentOutdated`）。そのコンピュータで次を実行します。

  ```sh
  npm i -g @uncage/cli@latest
  uncage setup https://your.site
  ```

  `uncage --version`は、1行目にCLIのバージョンを、2行目にCLIを実行しているNode.jsを表示します。

### サーバーレスで504エラーや「FUNCTION_INVOCATION_TIMEOUT」が出る

リクエストがプラットフォームの制限時間より長く続きました。

- **エージェントのストリームとブラウザのイベントストリーム**：`stream.maxDurationMs`を、余裕を持たせて制限より短く設定します（Vercelの`maxDuration = 300`なら`250_000`。これがデフォルトです）。こうすればハブが自分でストリームを終了させ、クライアントはすぐに再接続します。
- **サイトツールの呼び出し**：それぞれ1つのリクエストの中で実行されるため、`toolTimeoutMs`（120秒）も制限内に収める必要があります。プラットフォームに停止されたハンドラーは、「Site tool "<name>" timed out on the website. Please try again.」というエラーで失敗し、再実行されません。
- **アップロード**：リクエストボディは`bodyTimeoutMs`（30秒）以内に届く必要があり、遅いアップロードは`400`で拒否されます。遅い回線で大きな添付ファイルを扱う場合は、この値を上げてください（ただし制限より短くします）。
- **Vercelでの約4.5MBを超える添付ファイル**には、ハブが動く前にVercel独自の`413`が返ります。[Vercel → FAQ](/docs/ja/deploy/vercel/#約4mbを超える添付ファイルが失敗します)を参照してください。

### コンピュータが再接続を繰り返す、またはストリームが切れる

接続が切れるのは想定どおりで、害はありません。エージェントはカーソルを付けて再接続し、何も失われず、二重に届くこともありません。いつまでも落ち着かない場合にだけ、詳しく調べてください。

- **`http stream rotated`が数分ごとに**エージェントのログに出るのは正常です（ハブは`stream.maxDurationMs`でストリームを終了させます）。
- **数秒ごとにエラーが出る**：何かが長時間のリクエストを早めに閉じています（プロキシやCDNのタイムアウト）。そのタイムアウトを`stream.maxDurationMs`より長くするか、`stream.maxDurationMs`をそれより短くしてください。
- **レスポンスが一度にまとめて届く**（プロンプトへの回答が最後にしか表示されない）：プロキシがストリームをバッファリングしています。`<basePath>/sessions/*/events`と`<basePath>/agent/stream`のバッファリングを無効にしてください（nginx：`proxy_buffering off;`）。ハブはエージェントのストリームに`X-Accel-Buffering: no`を付けて送りますが、すべてのプロキシがこれに従うとは限りません。
- **`/agent/*`で`429`が出る**：トークンが誤っているエージェント（たとえば取り消されたのにまだ動いているコンピュータ）が`agentAuthFailuresPerMinute`に達しました。そのコンピュータで`uncage sites`にサイトが表示されるので、`uncage setup <url>`をもう一度実行してください。

### Postgres：プーラーとサーバーレスのドライバー

- **トランザクションモードのプーラー**（PgBouncer、Neonの`-pooler`ホスト）は、`postgresHubStore`と`postgresCluster`で使えます。マイグレーションはトランザクション単位のロックを使います。
- **Neonの`neon()`HTTP関数は失敗します**：ハブは1つの接続上でトランザクションを必要とします。`pg`か、`@neondatabase/serverless`のNeonの`Pool`を使ってください。
- **接続数が多すぎる**：関数インスタンスはそれぞれ独自のプールを開きます。プール接続のURLを使い、各プールは小さく（`max: 5`）して、ストアとクラスターで共有してください。
- **`Connection terminated`でNodeプロセスがクラッシュする**：自分で作成したプールには、必ず`pool.on('error', …)`を付けてください。

### コンピュータの電源が切れていると履歴が消える

これは`sessionStorage: 'machine'`（デフォルト）の動作です。サイトにレプリカを保持するには`sessionStorage: 'site'`を使ってください（[サイトストレージ](/docs/ja/guides/site-storage/)）。

### Claude Codeがツールを呼ばない

- ツールが実行のマニフェストに含まれていない：`selectManifest`を確認してください（未知の名前は警告なしに無視されます）。
- 説明に、いつ使うべきかがモデル向けに書かれていない。何をするのか、いつ使うのかを書き、手順の一部であればスキルでも言及してください。
- セッションがCodexを使っている（サイトツールにはまだ対応していません）。
- チャットでは、ツールのステップのエラーからさらに詳しくわかります：`invalid_request`（引数が`input`に合致しない）、`tool_failed`（ハンドラーが例外を投げた、タイムアウトした、または`not_in_manifest`）。

### 送信時に「Your computer is offline. Make sure the agent (`uncage agent`) is running on it.」（コンピュータがオフラインです） / `machine_offline`になる

選択中のコンピュータがオフラインです。ヘッダーのコンピュータメニューで別のコンピュータを選ぶか、エージェントを起動してください。

### `/device`がフレーム内に表示できてしまう、または承認ボタンが反応しない

[認証とデバイスの承認](/docs/ja/guides/auth-and-device-approval/#承認ページdevice)を参照してください。このページには`frame-ancestors 'none'`、`X-Frame-Options: DENY`、そしてフレームワークが受け付けるPOSTによる判定（Next.jsのServer Action、またはOriginをチェックするエンドポイント）が必要です。

### 「The Uncage hub is not running: start the app with `node server.ts`」

`next dev`で起動しています。ハブはカスタムサーバーの中にあるため、`npm run dev`（`node server.ts`）で起動してください。

## Local モード

### 「The Uncage daemon is not reachable」 / 「token was not found」

先に`npx uncage serve`を起動してください。デーモンを`--token-file`付きで起動した場合は、アプリに`UNCAGE_TOKEN`を渡してください。

### 403 `forbidden_origin`

メッセージを読んでください。該当するヘッダーが示されています。

- **「Host … is not allowed」**：ブラウザが送る`Host`が、許可されたホスト名ではありません。たとえば`next dev`が表示する`Network:`のURL、開発用ドメイン、トンネルを開いた場合です。そのホスト名（ポートなし）を`allowedHosts` / `UNCAGE_ALLOWED_HOSTS`に追加してください。
- **「Origin … does not match Host …」**：ブラウザとアプリの間にある何かが`Host`を書き換えています。Viteやwebpackの開発用プロキシでは`changeOrigin: false`、nginxでは`proxy_set_header Host $host;`を設定してください。

Connected モードで同じコードが出た場合は、クロスサイトのPOSTがハブに届いたことを意味します。リクエストの`Origin`が`publicUrl`でもリクエスト自身の`Host`でもありません。プロキシが`Host`を維持していること、`publicUrl`が正確である（スキームとポートを含めて）ことを確認してください。

### ポート4783が使用中

別の`uncage serve`が動いています。それを停止するか、`--port 4784`を使い、アプリには`UNCAGE_URL=http://127.0.0.1:4784`を設定してください。

### Claude Codeに「auth required」と表示される

`claude`を実行して`/login`を入力し、`uncage serve`（Local モード）またはエージェント（Connected モード）を再起動してください。

## それでも解決しない場合

- `npx uncage doctor`（Local モード）：失敗したチェックごとに解決方法が表示されます。
- `uncage activity --follow`（Connected モード、コンピュータ上で）：ウェブサイトが何を要求し、何が失敗したかがわかります。
- エラーの`requestId`と、セッションの問題であれば`uncage doctor --export-events <sessionId> --out events.json`（Local モード。内容は秘匿化されます）の出力を添えて、Issueを作成してください：[github.com/ptmafia/uncage/issues](https://github.com/ptmafia/uncage/issues)。
