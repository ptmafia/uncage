---
title: "アプリの認証"
description: "モバイルアプリなどのネイティブクライアントがハブにサインインする方法：あなたのgetUserが、あなたの発行するAuthorizationのBearerトークンを読み取り、アプリはCookieもOriginも送らず、別のOriginからのウェブサイトのリクエストは引き続き拒否されます。"
---

ハブがユーザーの資格情報を発行することはありません。アプリでも、`getUser(req)`はウェブサイトの場合と同じ仕事をします。サインイン中のユーザーを返すか、`null`を返します。違いは見る場所だけで、Cookieの代わりに`Authorization: Bearer <token>`ヘッダーを見ます。

## ハブはアプリのリクエストをどう扱うか

- **`Origin`ヘッダーのない**リクエスト（すべてのネイティブHTTPスタック）は、状態を変更するものも含め、すべてのブラウザAPIルートでクロスサイト保護を通過します。CSRFはブラウザの問題です。別サイトが行ったリクエストにCookieを付けるのはブラウザだけで、ブラウザはそのようなリクエストに必ず`Origin`を付けます。
- **別の`Origin`**を持つリクエスト（別サイトのウェブページ）は、有効なCookieがあっても`403 forbidden_origin`で拒否されます。
- ブラウザが勝手にBearerヘッダーを付けることはないため、トークンがCSRFで悪用されることはありません。

したがって、`getUser`はCookieとBearerトークンの両方を受け付けるようにし、`Origin`を自分で信頼しないでください。

## Bearerトークンを使う`getUser`

```ts title="auth.ts"
import type { HubUser } from '@uncage/hub';

/** Your token check: a signed token, an OAuth access token, a session id … → user or null. */
declare function userForToken(token: string): Promise<{ id: string; name: string } | null>;
/** Your cookie check (the web sign-in). */
declare function userForCookie(req: Request): Promise<{ id: string; name: string } | null>;

export async function getUser(req: Request): Promise<HubUser | null> {
  const header = req.headers.get('authorization');
  if (header !== null) {
    // A bearer header decides alone: an invalid token is never rescued by a cookie sent with it.
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return m ? await userForToken(m[1]!) : null;
  }
  return userForCookie(req);
}
```

トークンは、すでにあるサインイン（OAuth、セッションの仕組み、マジックリンク）から発行します。有効期限と更新用のルートを設け、アプリ内ではOSのキーチェーン（`expo-secure-store`）に保存し、クライアントの非同期`headers`オプションで送ります（[React Nativeアプリ](/docs/ja/guides/react-native/)）。

## デモのトークン

`examples/connected-demo`に最小限の実装があります。**デモ専用**です。

- `POST /api/app/token`は`{ token, user, expiresAt }`を返します。トークンは`uat1.<ユーザー名>.<有効期限>.<hmac>`の形で30日間有効です。署名鍵はCookieの鍵に専用のラベルを付けて派生させているため、Cookieがアプリのトークンとして有効になることも、その逆もありません。処理は次の順です。有効なBearerトークンの更新（無効なら`401`）、サインイン済みのCookieユーザー、公開デモ（`DEMO_PUBLIC=1`）ではランダムな新しいゲスト（クライアントIPごとに1分あたり最大10人、超えると`Retry-After`付きの`429`）、それ以外はリクエストボディの`{ "username": "…" }`（パスワードなし：デモ専用）。
- 状態を変更するほかのルートと同様、別の`Origin`のリクエストは拒否します。
- 実際のサイトは、自前の認証でトークンを発行し、上のように`getUser`で検証します。

## チェックリスト

- [ ] トークンはランダムまたは署名付きで、期限があり、失効できる。保存先はキーチェーンで、通常のストレージではない。
- [ ] 無効なBearerトークンに対して`getUser`は`null`を返し、Cookieにはフォールバックしない。
- [ ] トークンのエンドポイントにレート制限があり、別の`Origin`を拒否する。
- [ ] `trustedOrigins`に`null`、`file://`、ワイルドカードを入れない。アプリには不要です（必要なのは[ブラウザ拡張機能](/docs/ja/guides/browser-extension/)です）。

[認証とデバイスの承認](/docs/ja/guides/auth-and-device-approval/)と[セキュリティ](/docs/ja/reference/security/)も参照してください。
