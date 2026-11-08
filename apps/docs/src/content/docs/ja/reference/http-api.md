---
title: HTTP API
description: ハブのブラウザAPI、デバイスエンドポイント、インストーラーのすべてのルートと、それらとLocal モードのデーモンの/v1 APIとの対応、リクエストボディ、ヘッダー、SSE、エラーレスポンスについて説明します。
---

これらを自分で呼び出すことはほとんどありません。呼び出すのは`@uncage/client`（とその上に作られたReactパッケージ）です。ここでは、独自のクライアント、デバッグ、コーディングエージェント向けに一覧を示します。すべてのボディの型は`@uncage/protocol`にあります。

## 2つのサーバー、1つのAPIの形

| | Connected モードのハブ | Local モードのデーモン |
| --- | --- | --- |
| ベース | `<publicUrl><basePath>`（デフォルトは`/api/uncage`） | `http://127.0.0.1:4783/v1`。`/api/uncage`のプロキシ経由でアクセスします |
| 認証 | `getUser(req)`を介したサイトのCookie | `Authorization: Bearer <token>`。プロキシが付与します |
| 追加分 | `/machines`、デバイスエンドポイント、`install.sh`、エージェントのWebSocket | なし |

セッション、実行、イベント、承認のルートは、どちらでもリクエストとレスポンスの形が同じです。そのため、同じクライアントがどちらに対しても動作します。`/api/uncage`を指定すれば、ハブともプロキシともやり取りできます。

## ブラウザAPI

以下のルートはすべて、サインイン中のユーザーが必要です（いなければ`401 unauthorized`）。他のユーザーのリソースは、存在しない場合と同じく`404`を返します。別のオリジンからのGET以外のリクエストは`403 forbidden_origin`になります。

| メソッドとパス | ボディ / クエリ | 応答 |
| --- | --- | --- |
| `GET /health` | | `{ ok: true, protocol: "1.0", version }` |
| `GET /runtimes` | `?machineId=`（任意） | そのコンピュータの`RuntimeInfo[]`。指定がなければ、最初のオンラインのコンピュータのもの |
| `GET /machines` | | `MachineInfo[]`：`{ id, name, os, agentVersion, runtimes, online, lastSeenAt }`。最後に確認された時刻が新しい順 |
| `GET /machines/install` | | `{ install, setup, windows: null }`：表示する2つのコマンド |
| `DELETE /machines/:id` | | `{ ok: true }`。コンピュータを取り消します |
| `GET /sessions` | | `Session[]`。それぞれに`machineId`が付き、古い順 |
| `POST /sessions` | `{ runtime, title?, machineId? }` | `201 Session`。`machineId`がない場合は、最後に確認されたオンラインのコンピュータ。`workspace`は無視されます |
| `GET /sessions/:id` | | `SessionSnapshot`：`{ session, runs, pendingApprovals, lastSequence }` |
| `PATCH /sessions/:id/settings` | `{ model?, effort?, permissionMode? }`（1つ以上） | `Session` |
| `POST /sessions/:id/runs` | `{ prompt, attachmentIds? }` +ヘッダー`Idempotency-Key` | `202 Run` |
| `GET /sessions/:id/events` | `?after=<sequence>`またはヘッダー`Last-Event-ID` | `UncageEvent`のSSEストリーム。`Accept: application/json`を付けるとJSON配列（`?limit=`） |
| `POST /sessions/:id/attachments` | 生のバイト列。ヘッダー`Content-Type`、`X-Filename`（URIエンコード） | `Attachment`。最大10 MiB |
| `GET /attachments/:id` | | ファイル |
| `GET /runs?active=1` | | `ActiveRunInfo[]`：ユーザーのセッションで進行中の実行 |
| `GET /runs/:id` | | `Run` |
| `POST /runs/:id/cancel` | | `202` |
| `GET /approvals?sessionId=` | | そのセッションの保留中の`ApprovalRequest[]` |
| `POST /approvals/:id/decision` | `{ decision: "allow" \| "deny", scope: "once" \| "session", reason? }` +ヘッダー`Idempotency-Key` | 更新された`ApprovalRequest`。2回目に異なる判定を送ると`409` |

Local モードのデーモンには、`/machines*`を除く同じルートが`/v1`配下にあり、`POST /v1/sessions`では`workspace`（許可されたルートの内側）を受け付けます。

### Server-Sent Events

`GET /sessions/:id/events`は`text/event-stream`をストリーミングします。各イベントはSSEの`id`としてシーケンス番号を持つため、再接続した`EventSource`（または`@uncage/client`）は`Last-Event-ID`で再開します。プロキシがストリームを閉じないよう、15秒ごと（`sseHeartbeatMs`）にコメント行が送られます。届くイベントは次のとおりです：`session.created`、`session.updated`、`run.started`、`run.updated`、`run.completed`、`run.failed`、`run.cancelled`、`run.interrupted`、`message.started`、`message.delta`、`message.completed`、`tool.started`、`tool.updated`、`tool.completed`、`tool.failed`、`approval.requested`、`approval.updated`、`approval.resolved`、`system.warning`。

## マシン側（公開）

CLIとエージェントが使います。これらは`getUser`を呼びません。

| メソッドとパス | |
| --- | --- |
| `GET /install.sh` | インストーラー（`text/plain`）。内容は固定で、変わるのはCLIのバージョン範囲だけです |
| `POST /device/code` | デバイスログインを開始します。ユーザーコード、検証用リンク、ポーリング間隔（2秒）、有効期限（600秒）を返します。クライアントIPごとにレート制限があります |
| `POST /device/token` | `{ deviceCode }`：ユーザーが承認するまでポーリングし、承認後に マシントークンを1回だけ返します |
| `POST /machine/revoke` | `Authorization: Bearer <machine token>`：コンピュータが自身を取り消します（`uncage sites remove`） |
| `GET /agent`（WebSocketのアップグレード） | エージェントの接続（`Authorization: Bearer <machine token>`）。`hub.attach(server)`が登録します。プロトコルバージョンは1で、フレームはJSON、各1 MiBまでです |

## エラー

すべてのエラーは、そのコードに対応するHTTPステータスを持つJSONです。

```json
{ "code": "machine_offline", "message": "The machine is offline.", "hint": "Make sure the Uncage agent is running on that machine and connected to the internet.", "retryable": true, "requestId": "req_…" }
```

必要に応じて`details`が追加されます（例：`details.reason`、`details.retryAfterSec`）。全一覧は[エラーコード](/docs/ja/reference/errors/)にあります。
