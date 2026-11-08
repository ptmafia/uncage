---
title: エラーコード
description: Uncageのすべてのエラーコードについて、HTTPステータス、再試行の可否、意味、対処方法をまとめています。Connected モードのコード（machine_offline、tool_failed、upgrade_required / 426、rate_limited）と、details.reasonの値（interrupted、link_closed、link_replaced、not_in_manifestなど）も含みます。
---

ハブ、デーモン、プロキシ、ツール呼び出しから返るエラーは、すべて同じ形をしています（`@uncage/protocol`の`ErrorBody`）。

```json
{ "code": "tool_failed", "message": "…", "hint": "…", "retryable": true, "details": { "reason": "not_in_manifest" }, "requestId": "req_…" }
```

Reactでは、`useUncageError()`がこれを`{ error: { code, message, hint, … } }`として返します。`<AgentChat>`はUIの言語でメッセージとヒントを表示します。

| コード | ステータス | 再試行 | 意味と対処 |
| --- | --- | --- | --- |
| `unauthorized` | 401 | 不可 | サインイン中のユーザーがいない（`getUser`が`null`を返した）、デーモンのトークンがないか間違っている、マシントークンが不明か取り消されている、またはメンテナンスのシークレットが間違っています。サインインしてください。Local モードでは`UNCAGE_TOKEN`を確認してください。コンピュータ上では`uncage setup <url>`をもう一度実行してください。 |
| `forbidden_origin` | 403 | 不可 | ハブへのクロスサイトリクエスト、またはプロキシの`Host` / `Origin`チェックの失敗です。メッセージに該当するヘッダーが示されます。[トラブルシューティング](/docs/ja/reference/troubleshooting/#403-forbidden_origin)を参照してください。 |
| `not_found` | 404 | 不可 | そのようなセッション、実行、承認、添付ファイルが存在しない、**または他のユーザーのものです**。`ctx.files.read`で存在しないパスを指定した場合や、ハブが知らない実行からのツール呼び出し（`details.reason: 'run_not_indexed'`）でも返ります。 |
| `invalid_request` | 400 | 不可 | ボディまたはパラメーターがスキーマに合致しない、リクエストボディが上限を超えている（エージェントのルートでは1MiB）、または`bodyTimeoutMs`以内に届かなかった場合です。サイトツールでは、引数が`input`に合致しなかった（ハンドラーは実行されていません）か、ファイルチャネルのパスがワークスペースの外に出た、または`read`にフォルダを指定した場合（`details.reason: 'is_directory'`）です。エージェントのトランスポートでは、`details.reason`が`link_replaced`、`link_closed`、`hub_too_old`のいずれかになります（後述）。 |
| `machine_offline` | 409 | 可 | ユーザーのコンピュータが接続されていません。UIは接続を待ちます。ユーザーはエージェントを起動する（`uncage agent`、またはバックグラウンドサービスを確認する）必要があります。 |
| `machine_not_found` | 404 | 不可 | このユーザーにそのようなコンピュータがないか、まだ1台も接続していません（「Connect your computer first」）。 |
| `upgrade_required` | 426 | 不可 | エージェントがハブの`minAgentVersion`（デフォルトは0.3.0）より古いか、WebSocketが提供されていない環境（FaaS モード）で0.2のエージェントがWebSocketで接続しようとしました。WebSocketの場合、エージェントは自分でアップグレードし（`npm i -g @uncage/cli@latest`）、再接続します。FaaS モードでは、ウェブサイトに「Agent update needed」（エージェントの更新が必要）と表示され、ユーザーがそのコマンドを実行してから`uncage setup <url>`を実行します。 |
| `tool_failed` | 502 | 可 | サイトツールの呼び出しが失敗しました。ハンドラーが例外を投げた（そのメッセージが伝えられます）、タイムアウトした（`toolTimeoutMs`）、キャンセルされた（実行が終了した）、結果が大きすぎた、または`details.reason`が`not_in_manifest`、`too_many_concurrent`、`interrupted`のいずれかです（`interrupted`は、実行していたインスタンスが停止した場合です。メッセージは「Site tool "<name>" timed out on the website. Please try again.」で、自動的に再実行されることはありません）。 |
| `policy_denied` | 403 | 不可 | ポリシーにより拒否されました。`localPolicy.allowBypass`（Connected）または`security.allowBypass`（Local）なしでの`bypassPermissions`、あるいは`localPolicy.allowedPermissionModes`にないモードです。 |
| `rate_limited` | 429 | 可 | 1つのIPからのデバイスコードが多すぎる、1人のユーザーによる間違ったユーザーコードが多すぎる、または1つのIPからの誤ったマシントークンによるリクエストが多すぎます（`details.retryAfterSec`）。カウントはストアで、全インスタンス合計として行われます。 |
| `device_code_expired` | 410 | 不可 | セットアップのコードが10分以上前のものです。`uncage setup <url>`をもう一度実行してください。 |
| `session_busy` | 409 | 可 | セッションにはすでにアクティブな実行があります。待つか、停止してください。 |
| `session_read_only` | 409 | 不可 | セッションをこれ以上続けられません（たとえばClaude Codeがネイティブのセッションを失った場合）。新しいセッションを開始してください。 |
| `approval_expired` | 410 | 不可 | 承認が10分以上待たされました。もう一度依頼してください。 |
| `approval_already_resolved` | 409 | 不可 | 誰か（別のタブ、別のノード）が先に判定しました。再読み込みしてください。 |
| `event_replay_unavailable` | 410 | 不可 | 要求されたイベントはもうありません。新しいスナップショットを取得し、その`lastSequence`から再開してください。 |
| `runtime_unavailable` | 503 | 不可 | そのマシンにランタイム（Claude Code、Codex）がインストールされていません。 |
| `auth_required` | 401 | 不可 | ランタイムがサインインしていません。`claude`を実行し、`/login`を入力してください。 |
| `unsupported_capability` | 422 | 不可 | ランタイムがこの操作に対応していません。例：対応していない添付ファイルの種類、設定、承認オプション。（Codexのセッションでのサイトツールは拒否されません。実行はツールなしで始まり、`site_tools_unsupported`の警告が表示されます。） |
| `runtime_disconnected` | 502 | 可 | 実行の途中でランタイムのプロセスが終了しました。新しい実行を開始してください。履歴は保持されています。 |
| `invalid_workspace` | 400 | 不可 | Local モード：ワークスペースが`workspace.allowedRoots`の外にあります。 |
| `store_locked` | 423 | 可 | 別のプロセスが同じデータディレクトリを使っています（2つ目のデーモン、または1つのPGliteフォルダを使う2つのハブ）。 |
| `attachment_too_large` | 413 | 不可 | 10MBを超えています（Claude Codeの画像は5MB）。Vercelでは、約4.5MBを超えるボディはプラットフォームが先に独自の413で拒否します。 |
| `attachment_type_unsupported` | 415 | 不可 | 許可されていない画像またはファイルの種類です。 |
| `internal_error` | 500 | 不可 | バグまたは予期しない障害です（`selectManifest`が例外を投げた、またはツールを選びすぎた場合も含みます）。サーバーのログで`requestId`を確認してください。 |

## `details.reason`の値

一部のコードには、詳しい情報を示す`details.reason`が付きます。

| コード | `details.reason` | 意味 |
| --- | --- | --- |
| `tool_failed` | `not_in_manifest` | そのツールはこの実行に提供されていませんでした（`selectManifest`）。 |
| `tool_failed` | `too_many_concurrent` | 1つのインスタンス上で、1台のコンピュータの実行中の呼び出しが`maxConcurrentToolCalls`（8）を超えました。 |
| `tool_failed` | `interrupted` | ハンドラーを実行中のハブのインスタンスが呼び出しの途中で停止しました（クラッシュ、デプロイ、プラットフォームの制限時間）。最大1回：再実行されません。 |
| `not_found` | `run_not_indexed` | ハブが開始していない実行からのツール呼び出しです。 |
| `invalid_request` | `is_directory` | `ctx.files.read`にフォルダが指定されました。 |
| `invalid_request` | `link_replaced` | エージェントのトランスポート：新しい`POST /agent/connect`がこのリンクを置き換えました。エージェントはこのリンクを停止します。 |
| `invalid_request` | `link_closed` | エージェントのトランスポート：リンクが閉じられました（たとえば切断の後）。エージェントはもう一度接続します。 |
| `invalid_request` | `hub_too_old` | エージェントのトランスポート：エージェントがハブより新しいプロトコルを話しています。`@uncage/hub`を更新してください。 |

## セッション内の警告

これらはエラーではありません。実行は続行され、セッションのイベントにコード付きの`system.warning`が含まれます。

| 警告コード | 意味 |
| --- | --- |
| `site_tools_unsupported` | セッションのランタイムがサイトツールを呼び出せません（現時点ではCodex、または`mcp: off`のACP エージェント）。実行はスキルだけで始まります。 |

## モデルに見えるツールのエラー

サイトツールが失敗すると、Claude Codeはエラーをツールの結果として受け取り、通常は立て直そうとします。つまり、**メッセージはプロダクトの一部です**。「No order ord_9 in your account.」は役に立ちますが、「TypeError: cannot read properties of undefined」は役に立たないうえ、内部情報を漏らすおそれがあります。[ツールを定義する → エラー](/docs/ja/guides/define-tools/#エラー)を参照してください。
