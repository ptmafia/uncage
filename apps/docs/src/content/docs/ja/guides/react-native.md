---
title: "React Nativeアプリ"
description: "Expo / React Nativeアプリで@uncage/clientと@uncage/reactを使う方法：expo/fetchによるストリーミング、Bearerトークンのヘッダー、開いているセッションを保存するストレージアダプター、写真のアップロード、バックグラウンドからの復帰、スマートフォンで新しいコンピュータを承認する手順。"
---

ネイティブアプリは、同じハブへのもう1つの入口です。アプリが通信するのは**あなたのバックエンド**（ハブ）だけで、あなたが発行するBearerトークンでサインインし、ウェブサイトと同じようにユーザー自身のコンピュータを操作します。アプリがマシントークンを持つことも、コンピュータと直接通信することもありません。

`@uncage/client`と`@uncage/react`（UIを持たないフック）は、変更なしでReact Nativeで動きます。`react-native`や`expo-*`は何もインポートせず、プラットフォーム固有の部分はすべてアプリが渡すアダプターです。React Native用のUIキットはありません。[`examples/connected-expo`](https://github.com/ptmafia/uncage/tree/main/examples/connected-expo)が、フックで画面を組み立てる方法を示しています（インストールするのではなく、コピーして使うものです）。

:::note[ステータス]
ビルド済みで、シミュレートしたReact Native環境（`window.location`なし、`localStorage`なし、`EventSource`なし、ストリーミング対応の`fetch`、非同期ヘッダー）でユニットテスト済みです。実機での検証：まだ行っていません（実機での確認待ち）。Expo Goでチャット、コンピュータ、承認、写真を確認できます。プッシュとアプリリンクには開発ビルドが必要です（[プッシュ通知](/docs/ja/guides/push-notifications/)）。
:::

## 1. ハブ側

アプリのためにハブに必要なのは、アプリのトークンを受け付ける`getUser`（[アプリの認証](/docs/ja/guides/authenticate-apps/)）と、必要ならプッシュ（[プッシュ通知](/docs/ja/guides/push-notifications/)）です。ネイティブのリクエストには`Origin`ヘッダーがないため、ハブのクロスサイト保護は通します。別のサイトのブラウザページは、これまでどおり拒否されます。

## 2. クライアント

パッケージをインストールし、ストリーミング対応の`fetch`とトークンでクライアントを作ります。

```ts nocheck
import { createUncageClient } from '@uncage/client';
import { fetch as streamFetch } from 'expo/fetch';

export const client = createUncageClient({
  baseUrl: 'https://your.site/api/uncage',
  fetch: streamFetch,
  // Called for every request and every stream (re)connect; may be async (token refresh).
  headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
});
```

- **ストリーミング。** React Native組み込みの`fetch`はレスポンスボディをストリーミングできませんが、クライアントは`response.body.getReader()`からイベントを読み取ります。Expoの`expo/fetch`はストリーミングできます。素のReact Nativeでは、`body.getReader()`を提供する任意の`fetch`ポリフィルを使います。`TextDecoder`がない環境（古いHermes）では、クライアントが内蔵の小さなUTF-8デコーダーを使います。
- **アップロード。** `uploadAttachment`は、ブラウザの`File`のほか、`expo-image-picker`の`{ uri, name, type }`オブジェクトも受け付けます。後者の場合、クライアントはグローバルの`fetch(uri)`（React Native自身のもので、`file://`や`content://`を読めます）でファイルを読み、渡された`fetch`で送信します。渡す`fetch`が`expo/fetch`のときにファイルを別に読むのはこのためです。`examples/connected-expo`は、イベントストリームを`expo/fetch`に、それ以外のリクエストを組み込みの`fetch`に振り分けています。
- **画像。** `client.attachmentUrl(id)`には認証ヘッダーが必要なので、`<Image source={{ uri, headers }} />`で表示します。
- **非同期ヘッダー。** `headers()`が例外を投げる（トークン更新の失敗など）と、リクエストは`details.reason: 'headers'`付きの`unauthorized`で失敗します。ストリームは`onError`で通知し、再試行します。

## 3. フック

アプリを`UncageProvider`で包み、ウェブと同じようにフック（`useMachines`、`useSession`、`useRuns`、`useApprovals`など）を使います。アプリ特有の点は3つです。

```tsx nocheck
import { usePersistSession, useReconnect, type PersistSessionStorage } from '@uncage/react';
import * as SecureStore from 'expo-secure-store';
import { useEffect } from 'react';
import { AppState } from 'react-native';

const storage: PersistSessionStorage = {
  get: () => SecureStore.getItemAsync('uncage.session'),
  set: (id) => (id === undefined ? SecureStore.deleteItemAsync('uncage.session') : SecureStore.setItemAsync('uncage.session', id)),
};

export function useAppLifecycle() {
  usePersistSession(storage); // reopen the last conversation after a restart
  const reconnect = useReconnect();
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && reconnect());
    return () => sub.remove();
  }, [reconnect]);
}
```

- **`usePersistSession(storage)`**は`{ get, set }`アダプターを受け取ります（同期でも非同期でも可：AsyncStorage、SecureStore、MMKV）。既定の`'url'`、または`window` / `localStorage`がない環境での`'localStorage'`では何もせず、例外も投げません。
- **`useReconnect()`**は`client.reconnect()`を返します。開いているすべてのイベントストリームを、最後のシーケンスからすぐにやり直すので、アプリが数分間バックグラウンドにいても、取りこぼしも重複もありません。`AppState`が`active`になったときに呼びます。
- **`useDeviceApproval(code)`**は、次の承認画面を動かします。

## 4. スマートフォンでコンピュータを承認する

`uncage setup`は、承認リンクをターミナルのQRコードとして表示します（`--no-qr`で無効化、出力がターミナルでないときは省略されます）。ハブの検証パス（既定は`/device`）をAndroidのApp LinksやiOSのユニバーサルリンクでアプリに割り当てておけば、スキャンするとアプリの承認画面が開きます。そうでない場合は、スマートフォンでモバイルウェブの承認ページが開きます。

```tsx nocheck
import { useDeviceApproval } from '@uncage/react';

export function ApproveScreen({ code }: { code: string }) {
  const { lookup, state, error, approve, deny } = useDeviceApproval(code);
  // state: 'loading' | 'idle' | 'approving' | 'denying' | 'approved' | 'denied'
  //        | 'not_found' | 'expired' | 'error'
  // lookup: { name?, os?, expiresAt, repairsMachine } | null: show it so the user compares the computer.
  // error: { code, message }, e.g. 'rate_limited' (10 wrong codes in 10 minutes).
  return null; // render lookup, error and two buttons that call approve() / deny()
}
```

照会自体が失敗した場合（たとえば`rate_limited`）、`state`は`'error'`になります。判定の失敗では`error`が設定されて`'idle'`に戻るので、再試行できます。`approve()`と`deny()`は`'idle'`のときだけ動作します。内部では[`GET /device/lookup`と`POST /device/decision`](/docs/ja/reference/http-api/)を呼んでいます。`client.lookupDevice(code)`と`client.decideDevice(code, approve)`は、Reactなしで同じことをします。

- **Android App Links：** サイトで`/.well-known/assetlinks.json`（パッケージ名と署名証明書のフィンガープリント）を配信します。`examples/connected-demo`は`ANDROID_PACKAGE`と`ANDROID_SHA256`から生成します。ビルド済みでユニットテスト済み。実機での確認待ちです。
- **iOSユニバーサルリンク：** `/.well-known/apple-app-site-association`（Team IDとバンドルID。デモでは`APPLE_TEAM_ID`と`IOS_BUNDLE_ID`）を配信します。有料のApple Developerアカウントが必要です。実装済みで設定可能ですが、**実機では未検証**です。iOSでは、QRコードはモバイルウェブの承認ページにフォールバックします。

## 有料アカウントなしで

iOSのリンクとiOSのプッシュを除き、すべて無料のツールで試せます。チャット、コンピュータ、承認、ピッカー、写真はExpo Goで、Androidの開発ビルド（プッシュ、App Links）は無料のExpoアカウントとEASで、Androidのプッシュは無料のFirebaseプロジェクトで行えます。手順はサンプルのREADMEにあります。

## 次に読む

[アプリの認証](/docs/ja/guides/authenticate-apps/) · [プッシュ通知](/docs/ja/guides/push-notifications/) · [カスタムUI](/docs/ja/guides/custom-ui/) · [HTTP API](/docs/ja/reference/http-api/)
