---
title: トラブルシューティング
description: Connected モード（コンピュータが接続しない、オフラインになる、セットアップのエラー、ツールが呼ばれない、プロキシの背後のWebSocket）とLocal モード（デーモンに到達できない、forbidden_origin、ポート、サインイン）でよくある問題の解決方法。
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
- **Fetchスタイルのサーバー（Hono、Nextのルートハンドラーなど）**：プラットフォームのクライアントIPヘッダーを使って`createHub({ rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined } })`とするか、`hub.handler(req, { clientIp })`を渡します。
- **`rateLimits.trustForwardedFor: true`** は、プロキシがクライアントのアドレスを`X-Forwarded-For`に追記する場合に限って使います。

複数ノードの場合、制限はノードごとにカウントされます。詳細は[プロキシの背後で](/docs/ja/guides/mount-the-hub/#リバースプロキシやロードバランサーの背後で)を参照してください。

### ページに「Waiting for your computer…」が表示され続ける

1. コンピュータ上で`uncage sites`を実行し、サイトが`active`として表示されることを確認します。
2. エージェントは動いていますか？`launchctl print gui/$(id -u)/dev.uncage.agent | head`（バックグラウンドサービス）を実行するか、ターミナルで`uncage agent`を実行して出力を確認します。ログは`~/.uncage/logs/agent.err.log`にあります。
3. WebSocketに到達できますか？サーバーは、`publicUrl`を配信しているのと同じHTTPサーバーで`hub.attach(server)`を呼ぶ必要があります。また、前段のすべてのプロキシが`<basePath>/agent`のWebSocketのアップグレードを転送しなければなりません。アップグレードに素の404や502で応答するプロキシが、最もよくある原因です。
4. `publicUrl`はユーザーが開くURLでなければなりません。インストールとセットアップのコマンド、およびエージェントがそこから導くWebSocketのURLは、この値から作られます。

### エージェントは動いているのにコンピュータがオフラインと表示される

- ノートパソコンがスリープした、またはネットワークが変わった：エージェントはバックオフ（1秒から最大30秒）しながら再接続します。実行はローカルで続き、イベントは再接続時に補完されます。
- ロードバランサーのアイドルタイムアウトが約30秒未満だと、WebSocketが切断されます。タイムアウトを延ばしてください。ハブは10秒ごとにpingを送ります。
- コンピュータがサイトから取り消された：`uncage sites`に`revoked`と表示されます。`uncage setup <url>`をもう一度実行してください。
- エージェントが古すぎる（ログに`upgrade_required`）：エージェントは`npm i -g @uncage/cli@latest`で自分をアップグレードします。そのコンピュータでnpmに`sudo`が必要な場合、アップグレードは失敗します。npmのグローバルプレフィックスを修正し（`npm config set prefix ~/.npm-global`を実行して、その`bin`を`PATH`に追加）、再インストールしてください。

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
