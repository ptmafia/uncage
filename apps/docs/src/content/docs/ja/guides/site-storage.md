---
title: サイトストレージ
description: sessionStorage 'site' を使ってすべての会話のレプリカをウェブサイト側に保持し、ユーザーのコンピュータが停止していても履歴を読めるようにします。レプリカとツール呼び出しの監査記録を自分のコードから読む方法も説明します。
---

セッションはユーザーのコンピュータで実行され、そのコンピュータのローカルデータベースが信頼できる唯一の情報源です。問題は、**あなたのウェブサイト**もコピーを持つかどうかです。

| `sessionStorage` | コンピュータがオフラインのときの履歴 | ハブが履歴を読む場所 |
| --- | --- | --- |
| `'machine'`（デフォルト） | 見えません。セッション一覧は空になり、セッションを開くと `machine_offline` で失敗します | 毎回コンピュータに問い合わせます |
| `'site'` | すべて読み取り専用で見えます | ハブ自身のストア（レプリカ） |

エージェントの作業内容の確認、結果の共有、サポートなど、処理の過程をウェブサイト上で見られるようにしておきたい場合は `'site'` を選びます。リファレンスデモもこちらを使っています。閲覧中を除き、会話をユーザーのコンピュータの外に出してはならない場合は `'machine'` を選びます。

```ts title="hub.ts"
import { createHub, pgliteHubStore, type HubUser } from '@uncage/hub';

declare function getUser(req: Request): Promise<HubUser | null>;

export const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
export const hub = await createHub({
  publicUrl: 'https://app.example.com',
  getUser,
  store,
  sessionStorage: 'site',
});
```

## レプリカの仕組み

- ハブがレプリケートするのは、自分で作成したセッションだけです（`POST <basePath>/sessions` がセッション ID を決め、コンピュータがセッションを作成する前に記録します）。それ以外のセッション ID についてコンピュータが送ったイベントは無視され、ログに記録されます（`events for a session the hub did not create ignored`）。`'machine'` ストレージの場合、そうしたセッションも一覧に表示できるようインデックスには登録されます。

- セッションの各イベントにはシーケンス番号（1、2、3…）が付きます。コンピュータはまず自分のデータベースに書き込み、それからハブに送ります。
- ハブは欠けている**次の**シーケンスだけを追記します。そのため、レプリカは常にセッションの先頭から欠落のない連続した部分になり、ハブはどこまで受け取ったかを応答します。
- コンピュータが再接続すると、ハブはそのコンピュータの各セッションについて持っている最後のシーケンスを伝え、コンピュータはそこから再送します。オフラインの間に何かが失われることも、二重に保存されることもありません。
- イベントを書き込むのはコンピュータだけなので、競合は起きません。承認の判定も引き続きコンピュータ上で行われます。ハブは判定を転送し、結果はイベントとして戻ってきます。
- 非常に大きな単一のイベント（たとえば巨大なコマンド出力）は、1 フレームに収まるようエージェントが `[truncated N bytes]` マーカー付きで短縮します。レプリカの連続性は保たれます。
- ハブはセッションごとに**スナップショット**（セッション、実行、保留中の承認、最後のシーケンス）もイベントから再構築して保持します。そのため、セッションを開くときに履歴全体を再生する必要はありません。

コンピュータがオフラインの間、`<AgentChat>` は履歴を表示し、入力欄を無効にします（“Your computer is offline. Waiting for it to reconnect…”）。再接続すると欠けていたイベントが届き、セッションは再びライブになります。

## レプリカを自分で読む

`createHub` に渡したストアへの参照を保持しておけば、自分のページや管理ツール、エクスポート処理からそれを読めます。必ずサインイン中のユーザーで絞り込んでください。

```ts title="history.ts"
import type { HubStore, ToolCallRecord } from '@uncage/hub';
import type { UncageEvent } from '@uncage/protocol';

/** A user's conversations, newest first, with their titles. */
export async function listConversations(store: HubStore, userId: string) {
  const sessions = await store.listSessions(userId); // oldest first
  return sessions.reverse().map((s) => ({ id: s.id, title: s.title, machineId: s.machineId, createdAt: s.createdAt }));
}

/** Every replicated event of one of the user's sessions, in order. */
export async function readConversation(store: HubStore, userId: string, sessionId: string): Promise<UncageEvent[]> {
  const session = await store.getSession(sessionId);
  if (!session || session.userId !== userId) throw new Error('not found');
  const events: UncageEvent[] = [];
  for (let after = 0; ; ) {
    const page = await store.readEvents(sessionId, after, 500);
    if (page.length === 0) return events;
    events.push(...page);
    after = page[page.length - 1]!.sequence;
  }
}

/** What your tools did in a session: one row per call, with status and timing. */
export function toolCalls(store: HubStore, sessionId: string): Promise<ToolCallRecord[]> {
  return store.listToolCalls(sessionId);
}
```

`sessionStorage` が `'site'` の場合、`SessionRecord.snapshot` には最新のスナップショットが入ります。`HubStore` のすべてのメソッドは[自動生成リファレンス](/docs/api/hub/)（英語）に一覧があります。自分のコードからはストアを読み取り専用として扱ってください。テーブルはハブが管理しています。

## ツール呼び出しの監査記録（両モード共通）

`sessionStorage` の値にかかわらず、ハブはすべてのサイトツール呼び出しを記録します。記録されるのは、誰が（`userId`、`machineId`）、どのセッションと実行で、どのツールを、どの引数で（16 KB を超える場合を除く）呼んだか、そしてステータス（`running`、`ok`、`error`、`invalid`、`timeout`、`cancelled`）、エラーコードとメッセージ、所要時間です。`store.listToolCalls(sessionId)` で読み取れます。

## 保持期間とサイズ

ハブはレプリケートしたイベントを削除しません。容量を見積もっておいてください。典型的な実行は数十〜数百のイベントで、その大半は小さなテキストの差分です。保持期間を設けたい場合は、自分のスケジュールでデータベースから古いセッションの行を削除してください（テーブルは `migrateHubStore` が作成します。スキーマは `@uncage/hub` の `HUB_MIGRATIONS` を参照してください）。

## 添付ファイル

ブラウザでアップロードされた添付ファイルはコンピュータに送られ、コンピュータはセッションのワークスペースに独自のコピーを保存します。**`'machine'` を含むどちらのモードでも、ハブもストア（`uncage_hub_attachments`）にコピーを保持します。** そのため、画像やファイルはチャット履歴に表示され続けます。このコピーは次のタイミングで削除されます。

- `attachmentRetentionDays`（デフォルト 30。各ノードで 1 時間ごとの掃除処理がチェックします）の経過後。以降、`GET <basePath>/attachments/:id` は 404 を返します。
- コンピュータが取り消されたとき（ウェブサイトから、`hub.revokeMachine` で、またはコンピュータ上で `uncage sites remove` を実行）、即座に。

コンピュータが取り消されるまで保持したい場合は `attachmentRetentionDays: Infinity` を、添付ファイルをサーバーに残しておけない場合はより小さな値を指定してください。

## モードの切り替え

`sessionStorage` はいつでも変更できます。`'site'` に切り替えると、コンピュータが次に接続したときに、そのコンピュータのすべてのセッションが最初のイベントからレプリケートされます。`'machine'` に戻すと、既存のレプリカの行はストアに残りますが、使われなくなります。
