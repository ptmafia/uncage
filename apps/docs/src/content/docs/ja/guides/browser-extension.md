---
title: "ブラウザ拡張機能"
description: "エージェントをChromeのManifest V3サイドパネルに入れる方法：サイトのCookieでハブに対してAgentChatを動かし、chrome-extension://<id>にtrustedOriginsを設定し（正確なオリジンのみ）、拡張機能IDを固定し、CookieとSameSiteの注意点を押さえ、代替としてBearerトークンを使います。"
---

ブラウザ拡張機能も、ほかと同じクライアントです。サイドパネルが、`@uncage/react-ui`の`<AgentChat>`をあなたのハブに対して表示します。[`examples/connected-extension`](https://github.com/ptmafia/uncage/tree/main/examples/connected-extension)は、Viteでビルドする完全なChrome（Manifest V3）サイドパネルです。

:::note[ステータス]
ビルドとテスト済み：リポジトリの`extension-mock`エンドツーエンドプロジェクトが、パッケージ化していない拡張機能をChromiumに読み込み、デモにサインインし、偽のエージェントを接続して、パネルからセッションを実行します。ご自身のChromeプロファイルで手動で使う確認：確認待ちです。
:::

## パネル

```tsx nocheck
import { createUncageClient } from '@uncage/client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';

const client = createUncageClient({
  baseUrl: `${HUB_ORIGIN}/api/uncage`,
  fetch: (url, init) => fetch(url, { ...init, credentials: 'include' }),
});

export const Panel = () => (
  <UncageProvider client={client}>
    <AgentChat />
  </UncageProvider>
);
```

拡張機能にサインイン画面はありません。マニフェストのサイトのオリジンに対するホスト権限と`credentials: 'include'`により、ユーザーの**サイトのCookie**が送られるため、`getUser`には、そのサイトですでにサインインしているユーザーが見えます。Cookieに頼りたくない場合は、代わりにBearerトークンを送ります（`createUncageClient({ headers })`、[アプリの認証](/docs/ja/guides/authenticate-apps/)）。

## 拡張機能を信頼するようハブに伝える

拡張機能のオリジン`chrome-extension://<id>`はサイトとは別のオリジンなので、ハブのクロスサイト保護は状態を変更するリクエストを拒否します。次のように登録します。

```ts title="hub.ts"
import { createHub, type HubOptions } from '@uncage/hub';

declare const base: Omit<HubOptions, 'trustedOrigins'>;

export const hub = createHub({
  ...base,
  trustedOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
});
```

`trustedOrigins`のルール（不正なエントリがあると`createHub`は例外を投げます）：

- 正確なオリジンのみ：`scheme://host[:port]`、小文字、ワイルドカード、パス、クエリ、資格情報、末尾のスラッシュは不可。公開するすべてのID（ストア版、開発版）を列挙してください。
- 使えるスキーム：`https`、`chrome-extension`、`moz-extension`、`safari-web-extension`、そして`localhost`、`127.0.0.1`、`[::1]`に限り`http`。`file:`、`data:`、`javascript:`、`blob:`などは拒否されます。
- **自分で管理しているオリジンだけ。** 信頼されたオリジンは、ユーザーのCookieを使って状態を変更するリクエストを行えます。その拡張機能内で動くスクリプトはすべてユーザーとして振る舞うため、自社アプリと同じ扱いで配布してください。
- ウェブサイトに対する保護は弱まりません。ほかの別のオリジンは、引き続きすべて拒否されます。

`examples/connected-demo`では、`TRUSTED_ORIGINS=chrome-extension://<id>`（カンマ区切り）を設定します。

## 拡張機能ID

パッケージ化していない拡張機能のIDは、`manifest.json`に固定の公開`key`がない限り、パスで決まります。サンプルには使い捨てのキーが入っているので、開発中はIDが安定します（`chrome-extension://bocaoaanfikfdhmnhipmjpkcepaioapj`）。ご自身の拡張機能では削除してください。Chromeウェブストアのビルドは、ストアがIDを割り当てるので、そのIDを`trustedOrigins`に入れます。

## ビルドと読み込み

```sh
HUB_ORIGIN=https://your.site pnpm --filter connected-extension build
```

`HUB_ORIGIN`（サイトのオリジン。パスなし）は、マニフェストの唯一の`host_permissions`エントリとパネルの`baseUrl`になります。`chrome://extensions`を開き、デベロッパーモードをオンにして、**パッケージ化されていない拡張機能を読み込む**で`dist`フォルダを選び、ツールバーのアイコンをクリックしてサイドパネルを開きます。同じChromeプロファイルでサイトにサインインし、コンピュータを接続します（[ワンクリック接続](/docs/ja/guides/one-click-connect/)または`uncage setup`）。

## CookieとSameSite

Chromeは、ホスト権限を持つ拡張機能のページに、`SameSite=Lax`も含めてサイトのCookieを送ります。セッションCookieが`SameSite=Strict`の場合や、ユーザーがサイトのサードパーティCookieをブロックしている場合、パネルはサインアウト状態を表示します。そのときはBearerトークンを使ってください。

[ハブのマウント](/docs/ja/guides/mount-the-hub/)と[セキュリティ](/docs/ja/reference/security/)も参照してください。
