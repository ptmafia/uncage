---
title: Local モードの詳細
description: 入力欄のコントロール、添付ファイル、権限確認のバイパス、設定（uncage.config.yaml）、プロキシのホストとオリジンのチェック、そして Local モードのデーモンのセキュリティモデルについて説明します。
---

このページでは、Local モード（`uncage serve` と同一オリジンのプロキシ）の詳細をまとめています。入力欄と添付ファイルは、特に記載のない限り Connected モードでも同じように動作します。

## 入力欄

`<AgentChat>` のプロンプト入力欄（Claude Code 風）には、次のコントロールがあります。どれもランタイムが受け取る内容を実際に変更します。実際の Claude Code に対するライブ E2E テストスイートが、モデル、エフォート、パーミッションモード（バイパスを含む）、添付ファイル、実行中チップをカバーしています。

| コントロール | 役割 |
| --- | --- |
| **Model**（きらめきアイコン） | ランタイム自身のモデル一覧。Claude Code では `supportedModels()` で、先頭は `default` です |
| **Effort**（脳アイコン） | `low`、`medium`、`high`、`xhigh`、`max` |
| **Permissions**（盾アイコン） | `default`（コマンドと編集の前に確認）、`acceptEdits`（ファイルの編集は確認なし、コマンドは確認する）、`plan`（計画だけで何も変更しない）、`auto`（何に確認が必要かをランタイムが判断）。`bypassPermissions` は許可されている場合にだけ表示されます（後述） |
| **Attach**（+）、ドラッグ＆ドロップ、貼り付け | 画像はサムネイルで、その他のファイルはチップで表示されます。貼り付けたスクリーンショットは添付ファイルになり、貼り付けたテキストはテキストのままです |
| **Voice**（マイクアイコン） | ブラウザの Web Speech API による音声入力。対応していないブラウザでは非表示です |
| **N running** チップ | いずれかのセッションで進行中の実行。クリックするとその実行に移動します |
| **Send / Stop** | Enter で送信、Shift+Enter で改行。IME で変換中の Enter では送信されません。Stop は実行をキャンセルします |

設定はセッションごとに保存されます。最初のプロンプトの前は下書きに属し、セッションの作成時に適用されます。開いているセッションでの変更は**次の実行から**適用されます。進行中の実行と、その実行の未処理の承認カードは、開始時の設定を維持します。

**音声入力のプライバシー。** 音声認識を行うのは Uncage ではなくブラウザです。Chrome では、音声は Google の音声認識サービスに送られます。Uncage が受け取るのは結果のテキストだけです。初回使用時にはその旨の注意が表示されます。

## 権限確認のバイパス

`bypassPermissions` を使うと、エージェントは確認なしで任意のコマンドを実行し、任意のファイルを編集できます。デフォルトではオフで、その場合は選択肢にも表示されません。細工したリクエストを送っても `403 policy_denied` になります。

- **Local モード：** `uncage.config.yaml` で `security.allowBypass: true` を設定するか、`UNCAGE_ALLOW_BYPASS=1` を付けてデーモンを起動します。すると `uncage serve` が警告を表示します。
- **Connected モード：** ユーザー本人だけが、自分のコンピュータの `~/.uncage/agent.yaml` で `localPolicy.allowBypass: true` を設定できます（[ローカルポリシー](/docs/ja/guides/local-policy/)）。

その場合でも、UI でこのモードを選ぶと確認を求められ、有効な間は赤いバナーが表示され続けます。

:::caution
バイパスを許可するのは、エージェントがレビューなしで変更しても問題のないマシンとワークスペースだけにしてください。エージェントはファイルを削除でき、あなたのユーザーアカウントで実行できることは何でも実行できます。
:::

## 添付ファイル

- 画像：`png jpg jpeg gif webp`。ファイル：`txt md json csv yaml yml xml html css js ts tsx jsx py go rs java rb sh sql log pdf`。
- 1 ファイルあたり最大 10 MB、1 メッセージあたり最大 10 ファイルです。Claude Code では画像の上限は 5 MB です（Anthropic API の制限）。
- Claude は画像をインラインで受け取ります。その他のファイルはパスで渡され、Claude がツールを使って読みます。
- Local モードでは、アップロードされたファイルはセッションのワークスペースの `<workspace>/.uncage/attachments/<sessionId>/<attachmentId>-<name>` に保存されます。送信されなかったアップロードは 24 時間後に削除されます。Uncage は `.uncage/` を作成するときに `.uncage/.gitignore`（`*`）を書き込むため、添付ファイルがコミットされることはありません。git のワークスペースが `.uncage/` を無視していない場合、`uncage doctor` が警告します。
- `useAttachmentUrl` / `client.attachmentUrl` は、同一オリジンのプロキシ配下の URL を返します。素の `<img src>` は `Authorization` ヘッダーを送らないため、読み込めるのはプロキシがサーバー側でデーモンのトークンを付けているからです。
- Connected モード：アップロードはハブ（`POST <basePath>/sessions/:id/attachments`、最大 10 MiB）を経由してユーザーのコンピュータに送られます。1 フレーム、または 256 KiB のチャンクに分けて送られます。

## 設定

設定なしでも動作します。必要に応じて、`uncage serve` を実行するディレクトリに `uncage.config.yaml` を置いてください。未知のキーは名前を示して拒否されます。

```yaml
server:
  port: 4783
  eventRetentionDays: 7
security:
  allowedOrigins: []      # origins allowed to call the daemon directly (CORS-style); keep empty with the proxy
  approvalTtlMs: 600000
  allowBypass: false      # true offers the bypassPermissions mode (no approvals). Env: UNCAGE_ALLOW_BYPASS=1
workspace:
  allowedRoots: [/Users/me/code]
  default: /Users/me/code/my-app
runtimes:
  claude: { enabled: true }
  codex: { enabled: true }  # command: [codex, app-server]
```

プロキシの環境変数（アプリ側）：`UNCAGE_URL`（デフォルトは `http://127.0.0.1:4783`）、`UNCAGE_TOKEN`（デフォルトでは `~/.uncage/token` を読み取ります）、`UNCAGE_ALLOWED_HOSTS`。`--token-file` を付けてデーモンを起動した場合は、そのトークンを `UNCAGE_TOKEN` としてアプリに渡してください。

## セキュリティモデル（Local モード）

- **ループバックのみ。** デーモンは `127.0.0.1:4783` にバインドします。`Host` が `127.0.0.1:<port>` でも `localhost:<port>` でもないリクエストは 403 になります。
- **Bearer トークン。** すべての `/v1/*` 呼び出しには `Authorization: Bearer <token>` が必要です。トークンは `~/.uncage/token`（モード 600）にあります。ログに出力されることも、イベントに含まれることも、ブラウザに送られることもありません。トークンがなければ 401 になります。
- **クロスオリジンのブラウザは拒否。** `Origin` ヘッダー付きのリクエストは、そのオリジンが `security.allowedOrigins`（デフォルトは空）に含まれていない限り 403 になります。ブラウザがデーモンとやり取りするのは、同一オリジンのプロキシを通じてだけです。
- **プロキシもクロスオリジンのリクエストを拒否します。** `Origin` がブラウザのいるオリジン（リクエストのスキームと `Host` ヘッダー）と異なるリクエストは `403 forbidden_origin` になり、`Sec-Fetch-Site: cross-site` が付いた GET 以外のリクエストも同様です。スキームとポートが一致すれば、ループバックの名前は同じオリジンとして扱われます（`localhost:3000` = `127.0.0.1:3000`）。
- **DNS リバインディング対策。** プロキシは、許可されたホスト名に対してだけ応答します。チェックにはブラウザの `Host` ヘッダーを使います。デフォルトでは任意のポートの `localhost`、`127.0.0.1`、`[::1]` です。アプリを別のホスト名（LAN 内の名前、開発用ドメイン、トンネル）で配信する場合は、それを列挙してください。

  ```ts nocheck
  createUncageHandler({ allowedHosts: ['app.example.com', 'localhost'] });
  // or: UNCAGE_ALLOWED_HOSTS=app.example.com,localhost
  ```

  この一覧はデフォルトを**置き換えます**。ループバックの名前を引き続き使う場合は、それらも加えてください。ホスト名だけを書きます（スキームやポートは付けません）。リバースプロキシの背後では、元の `Host` を転送してください（nginx：`proxy_set_header Host $host;`）。
- **デフォルトで承認が必要。** 新しいセッションは `permissionMode: 'default'` を使います。保留中の承認は 10 分で期限切れになります。
- **ワークスペースは囲い込まれています。** セッションのワークスペースは（`realpath` で解決した後に）`workspace.allowedRoots` の内側でなければなりません。デフォルトでは、`uncage serve` を起動したディレクトリ、または `--workspace` のフォルダーです。
- **テレメトリーなし。** ログではトークンと Authorization ヘッダーが秘匿化され、info レベルではプロンプトのテキストも含まれません。

## デーモンを組み込む

`uncage serve` の代わりに、エンジンを自分の Node プロセスの中で動かすこともできます。`@uncage/core` の `createUncage()` と `@uncage/server` の `createUncageServer()` を使います。[自動生成の API リファレンス](/docs/api/core/)（英語）を参照してください。

## Codex の状況

Codex アダプター（`@uncage/runtime-codex`。stdio 上の JSON-RPC で `codex app-server` を操作します）は実装済みですが、検証は偽の app-server に対してしか行っていません。プロトコルは公式のスキーマと照合済みですが、実際の `codex` バイナリでは動かしていません。試す場合は、必要に応じて `runtimes.codex.command` を設定し、結果を報告してください。Codex がインストールされていない場合、UI と `doctor` は **not installed**（未インストール）と表示し、`npm i -g @openai/codex && codex login` というヒントを示します。Codex はまだサイトツール（Connected モード）に対応していません。
