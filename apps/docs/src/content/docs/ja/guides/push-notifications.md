---
title: "プッシュ通知"
description: "ユーザーのコンピュータが操作を待っているときに通知する方法：ハブのonAttentionフック（承認の要求、Runの完了または失敗）、最大1回の配信と古いイベントの抑制、すぐ使えるexpoPushNotifier、デバイストークンの登録、テスト方法。"
---

承認が待っているとき、あるいはRunが終わったとき、アプリを持ち歩いているユーザーは気づけるべきです。ハブはそのためにあなたの`onAttention`フックを呼び、プッシュはあなた自身のプロバイダーから送ります。Expo Push向けには、すぐ使えるハンドラーがあります。

## `onAttention`

```ts title="attention.ts"
import type { AttentionEvent, OnAttention } from '@uncage/hub';

export const onAttention: OnAttention = async (e: AttentionEvent, { waitUntil }) => {
  // e.kind: 'approval_requested' | 'run_completed' | 'run_failed'
  // e.userId, e.sessionId, e.sessionTitle?, e.machineId, e.machineName?, e.runtime?,
  // e.approval?: { id, title, kind }, e.at (when it happened on the computer)
  waitUntil(sendPush(e.userId, `${e.kind}: ${e.sessionTitle ?? e.sessionId}`));
};

declare function sendPush(userId: string, text: string): Promise<void>;
```

`createHub({ …, onAttention })`として渡します。動作は次のとおりです。

- **イベントごとに1回。** ハブがイベントを受理した後に、両方の`sessionStorage`モードで、`sessionId:sequence:kind`ごとに1回だけ呼ばれます。エージェントの再送や、複数のハブノードが同じイベントを見ても、通知は1回です。重複排除にはストアの任意メソッド`claimOnce(key, { ttlSec, now })`を使います（SQL、Postgres、PGliteのストアが実装済みで、記録は1日保持されます）。`claimOnce`のないカスタムストアは、ノードごとのメモリ内での重複排除（ベストエフォート）になります。
- **配信は最大1回。** ハンドラーが例外を投げるかrejectすると、エラーは`logger.error`に出力され、イベントは再試行**されません**。
- **取り込みをブロックしない。** エラーでイベントが失敗することはありません。FaaSプラットフォームでは、呼び出しはリクエストの`waitUntil`の下で実行されます。`ctx.waitUntil`で、同じコンテキストにさらに処理を渡せます。
- **古いイベントはスキップ。** イベントの時刻が**10分**より古いもの（エージェントが再接続後に補完した古いイベント）は通知されません。`'site'`モードでは、保存済みのスナップショットですでに回答済みの承認もスキップされます。
- **時計に関する注意。** 「古い」かどうかは、コンピュータの時計によるイベント時刻とハブの時計を比較して判断します。両方の時計を数分以内（NTP）に保ってください。時計が10分以上遅れているコンピュータは通知されません。ハブは警告をログに出します（コンピュータごとに最大1時間に1回）。

## `expoPushNotifier`

```ts title="hub.ts"
import { expoPushNotifier } from '@uncage/hub';

declare const tokenDb: {
  list(userId: string): Promise<string[]>;
  remove(token: string): Promise<void>;
};

export const onAttention = expoPushNotifier({
  // The user's Expo push tokens, from YOUR database: the hub never stores them.
  tokensFor: (userId) => tokenDb.list(userId),
  // Expo reported DeviceNotRegistered (app uninstalled): delete the token.
  onInvalidToken: (token) => tokenDb.remove(token),
});
```

`fetch`だけを使うので、ハブが動く場所ならどこでも動きます（Web標準のルートからエクスポートされています）。トークンごとに1メッセージを、1リクエストあたり最大100件で送り、アプリが適切なチャットを開けるよう`data: { sessionId, approvalId?, kind }`を付けます。

| オプション | |
| --- | --- |
| `tokensFor(userId)` | 必須。ユーザーのExpoプッシュトークン。 |
| `accessToken` | enhanced push securityが有効なときのExpoアクセストークン。 |
| `message(e)` | イベントごとの`{ title, body }`。`null`を返すと何も送りません。既定は短い英語の文面（`defaultPushMessage`）なので、ここで翻訳します。 |
| `onInvalidToken(token)` | Expoが`DeviceNotRegistered`と報告したトークンに対して呼ばれます。 |
| `fetch`、`endpoint` | `fetch`やExpoのエンドポイントの差し替え（テスト用）。 |
| `timeoutMs` | Expoへのリクエストがこの時間を過ぎても応答しない場合は中断され、呼び出しはrejectします（ハブがログに出します）。既定は`15000`。 |

リクエストの失敗やタイムアウト、`onInvalidToken`の例外、あるいはExpoが別の理由（たとえば`InvalidCredentials`）でメッセージを拒否した場合に、rejectします（ハブはエラーコードと件数をログに出しますが、トークンは出力しません）。

## トークンの登録

アプリは権限を求め、`expo-notifications`でトークンを取得し（`getExpoPushTokenAsync({ projectId })`）、**あなたの**バックエンドに送ります。バックエンドはユーザーごとに保存します。`examples/connected-demo`には`POST /api/app/push-token` `{ token }`（サインアウト時は`DELETE`）があり、トークンの形式を検証し、ユーザーごとに最大10個まで保持します（古いものから削除）。30日間再登録されないトークンも削除されます。トークンは同時に1人のユーザーにだけ属し、デバイスで最後にサインインした人が優先されるため、共有デバイスで前のユーザーに通知が漏れることはありません。トークンは準機密として扱ってください。デモでは、`EXPO_PUSH=1`（必要なら`EXPO_ACCESS_TOKEN`も）を設定すると、ハブの`onAttention`が有効になります。

## 何がどこで動くか

- リモートプッシュには**開発ビルド**が必要です。Expo Goは、SDK 53以降のAndroidでプッシュに対応していません。
- **Android：** 無料のExpoアカウントとEASでAndroidの開発ビルドを作れます。FCMの資格情報は無料のFirebaseプロジェクトで用意します。ビルド済みで、模擬のExpoエンドポイントに対するユニットテストは済んでいます。**実機での確認待ち**です。
- **iOS：** 有料のApple Developerアカウント（APNs）が必要です。実装済みで設定可能ですが、**実機では未検証**です。

## テスト

ハンドラーのユニットテストは、偽の`fetch`（そのためのオプションです）と、`approval.requested`を出すハブで行います。呼び出しが1回であること、同じシーケンスが再び来ても呼ばれないこと、10分より古いイベントでは呼ばれないことを確認します。ハブ自身のテストもまさにこれを行っています。

[ハブのマウント](/docs/ja/guides/mount-the-hub/)と[React Nativeアプリ](/docs/ja/guides/react-native/)も参照してください。
