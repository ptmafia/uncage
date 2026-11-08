---
title: 認証とデバイスの承認
description: getUserでハブをサインイン処理に接続し、/deviceの承認ページを安全に構築する方法（サインイン必須、frame-ancestors 'none'、CSRF対策済みのPOST）を、Next.jsと任意のNodeサーバーについて説明します。
---

ハブは独自のアカウントを持ちません。誰がサインインしているかをウェブサイトに尋ね、コンピュータをその人に紐づける処理はウェブサイトの承認ページに任せます。

## `getUser(req)`

`getUser`は、ハブへのすべてのブラウザリクエストをFetchの`Request`として受け取り、サインイン中のユーザーまたは`null`を返します。

```ts nocheck
getUser(req: Request): Promise<{ id: string; name?: string } | null>
```

- `id`は、ユーザーごとに一意で変わらない値でなければなりません。ハブはコンピュータ（machine）、セッション、ツール呼び出しの記録をこの値に紐づけて保存し、ツールハンドラーには`ctx.user.id`として渡します。
- `name`は表示用で、省略できます。
- `null`を返すと、リクエストは`401 unauthorized`で失敗します。CLIが使うデバイスエンドポイント（`/device/code`、`/device/token`、`/machine/revoke`）と`install.sh`は公開されており、`getUser`を呼びません。
- この関数はすべてのリクエスト（SSEの接続ごとを含む）で実行されるため、署名付きCookieのチェックやキャッシュしたセッションの参照など、高速な処理にしてください。

### セッションCookieから

多くのサインインライブラリは、セッションIDや署名付きトークンをCookieに保存します。`Cookie`ヘッダーから読み取ります。

```ts title="auth.ts"
import type { HubUser } from '@uncage/hub';

/** Your session store: session id → user. */
declare function findSession(sessionId: string): Promise<{ userId: string; displayName: string } | null>;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export async function getUser(req: Request): Promise<HubUser | null> {
  const sid = readCookie(req, 'session_id');
  if (!sid) return null;
  const session = await findSession(sid);
  return session ? { id: session.userId, name: session.displayName } : null;
}
```

ライブラリがFetchの`Request`を受け取るヘルパーを提供している場合（多くはそうです）、それを直接呼び出してください。`examples/connected-demo`アプリはHMACで署名したCookieを使っています。`lib/auth.ts`を参照してください。

### CookieとCSRF

ブラウザAPIはCookieで認証されるため、ハブはクロスサイトリクエストからAPIを保護します。GET以外のリクエストで、`Origin`が`publicUrl`でもリクエスト自身のホストでもないもの、または`Sec-Fetch-Site: cross-site`が付いたものは`403 forbidden_origin`になります。あわせて、セッションCookieは`SameSite=Lax`（または`Strict`）と`Secure`にしておいてください。

## 承認ページ（`/device`）

`uncage setup https://your.site`は`https://your.site/device?code=ABCD-2345`を開きます。パスは`verificationPath`オプションで変更できます。このページで、サインイン中のユーザーがコードを承認または拒否します。**承認すると、そのコンピュータにユーザーのアカウントへのアクセス権が与えられる**ため、このページはクリックジャッキングやCSRFの標的になります。次の要件を満たす必要があります。

1. **通常のサインイン済みセッションを必須にします**。ユーザーがサインインしていなければ、ログインページに送ってから戻します。
2. **フレーム内での表示を拒否します**：`Content-Security-Policy: frame-ancestors 'none'`と`X-Frame-Options: DENY`。
3. **CSRF対策済みのPOSTで判定します**。GETやリンクを開いただけで承認してはいけません。
4. **何を承認するのかを表示します**：コード（ユーザーはターミナルの表示と見比べます）と、`hub.lookupDevice`から得たコンピュータの名前とOS。

ハブには3つの呼び出しがあり、いずれもコードとサインイン中のユーザーを受け取ります。

| 呼び出し | 戻り値 |
| --- | --- |
| `hub.lookupDevice(code, user)` | 保留中のコードなら`{ name?, os?, expiresAt, repairsMachine }`、それ以外は`null`。`repairsMachine`は、承認するとこのユーザーのコンピュータのいずれかが再ペアリングされる場合に設定されます。そのコンピュータはIDとセッションを維持し、古いトークンは使えなくなります。 |
| `hub.approveDevice(code, user)` | `'ok'`、`'not_found'`、`'expired'`のいずれか |
| `hub.denyDevice(code, user)` | `'ok'`、`'not_found'`、`'expired'`のいずれか |

コードは`ABCDEFGHJKMNPQRSTUVWXYZ23456789`から選ばれた8文字で、`ABCD-2345`の形式で表示され、10分間有効です。大文字・小文字、スペース、ハイフンは無視されます。未知のコードは推測の失敗として数えられ、10分間に10回失敗すると（`rateLimits.userCodeFailures`、`userCodeWindowMs`）、これらの呼び出しは`code: 'rate_limited'`（`details.retryAfterSec`）のエラーを投げます。

`@uncage/react-ui`の`<ApproveDevice>`がこのページを描画します。コード、コンピュータ、再ペアリングの警告、**Approve**（承認）と**Deny**（拒否）のボタン、そして結果です。表示だけを担うコンポーネントなので、判定はサーバーで行います。失敗した呼び出しのエラーは`error`プロップに渡してください。ローカライズされたメッセージ（`rate_limited`なら「Too many requests. Wait a moment and try again.」）が表示されます。照会結果がある場合はボタンの上に、`lookupDevice`自体が失敗して`lookup`が`null`の場合は「This code is invalid or has expired」の代わりに表示されます。

### Next.js

Next.jsの完全な実装は[Connected モードのクイックスタート](/docs/ja/start/quickstart-connected/#7-承認ページ)にあります。`lookupDevice`を呼ぶサーバーコンポーネント、`approveDevice` / `denyDevice`を呼ぶServer Action（Server ActionはPOST専用で、Next.jsが`Origin`をチェックするため、これがCSRF対策になります）、`<ApproveDevice>`を包むクライアントコンポーネント、そして`next.config.ts`でのヘッダー設定です。実際のサインインへのリダイレクトを含む同じパターンが、`examples/connected-demo/app/device/`にあります。

承認ページにだけヘッダーを追加する例です。

```ts title="next.config.ts"
import type { NextConfig } from 'next';

const config: NextConfig = {
  async headers() {
    return [
      {
        source: '/device',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
```

### Express（任意のNodeサーバー）

Server Actionがない場合は、小さなエンドポイントを2つ書き、オリジンを自分でチェックします。以下は完全なサーバーです（`getUser`は[前述](#セッションcookieから)のものです）。ページ自体は、`<ApproveDevice>`を描画し、`fetch`でこれらのエンドポイントを呼び出す任意のReactページでかまいません。

```ts title="server.ts"
import { createServer } from 'node:http';
import { createHub, toNodeHandler, type HubUser } from '@uncage/hub';
import express, { type NextFunction, type Request as ExpressRequest, type Response } from 'express';
import { getUser } from './auth.ts';

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:3000';
const hub = await createHub({ publicUrl: PUBLIC_URL, getUser });

/** Your sign-in for Express requests (the same session as getUser). */
declare function userOf(req: ExpressRequest): Promise<HubUser | null>;

const app = express();
app.use(toNodeHandler(hub));
app.use(express.json());

// Never framed.
app.use('/device', (_req: ExpressRequest, res: Response, next: NextFunction) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

/** CSRF: state-changing requests must come from this site. */
function sameOrigin(req: ExpressRequest): boolean {
  const origin = req.get('origin');
  if (origin) return origin === new URL(PUBLIC_URL).origin;
  return req.get('sec-fetch-site') === 'same-origin';
}

app.get('/device/lookup', async (req, res) => {
  const user = await userOf(req);
  if (!user) return void res.status(401).json({ code: 'unauthorized' });
  const code = String(req.query.code ?? '');
  try {
    res.json({ lookup: code ? await hub.lookupDevice(code, user) : null });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    res.status(err.code === 'rate_limited' ? 429 : 500).json({ code: err.code ?? 'internal_error', message: err.message });
  }
});

app.post('/device/decision', async (req, res) => {
  if (!sameOrigin(req)) return void res.status(403).json({ code: 'forbidden_origin' });
  const user = await userOf(req);
  if (!user) return void res.status(401).json({ code: 'unauthorized' });
  const { code, approve } = req.body as { code?: unknown; approve?: unknown };
  if (typeof code !== 'string' || typeof approve !== 'boolean') return void res.status(400).json({ code: 'invalid_request' });
  try {
    const result = approve ? await hub.approveDevice(code, user) : await hub.denyDevice(code, user);
    res.json({ result }); // 'ok' | 'not_found' | 'expired'
  } catch (e) {
    const err = e as { code?: string; message?: string };
    res.status(err.code === 'rate_limited' ? 429 : 500).json({ code: err.code ?? 'internal_error', message: err.message });
  }
});

const server = createServer(app);
hub.attach(server);
server.listen(3000);
```

ページでは`GET /device/lookup?code=…`を呼び出し、`<ApproveDevice code lookup state error onApprove onDeny />`を描画して、`{ code, approve }`を付けて`POST /device/decision`を送ります（ブラウザは`fetch`のPOSTに`Origin`を付けます）。応答は`ApproveDevice`の`state`に対応づけます。`'ok'`は`'approved'`または`'denied'`に、`'not_found'`と`'expired'`はそのままです。エラーは`error`プロップに渡します（再試行できるようボタンは有効なままです。`lookup: null`の場合は、エラーが「コードが見つからない」というメッセージの代わりに表示されます）。

## コンピュータを取り消す

- **ウェブサイトから**：`<AgentChat>`のコンピュータメニューに、ユーザーのコンピュータが一覧表示されます。独自のUIでは`useMachines().revoke(id)`または`DELETE <basePath>/machines/:id`を使います。サーバーでは`await hub.revokeMachine(machineId, user)`を呼びます（他のユーザーのIDや未知のIDなら`machine_not_found`を投げます）。
- **コンピュータから**：`uncage sites remove <site id>`が、コンピュータ自身のトークンを使ってウェブサイト上でそのコンピュータを取り消し、ローカルのトークンを削除します。

どちらの方法でも、トークンは即座に使えなくなり、コンピュータは切断されます。セッションはストア（とコンピュータ上）に残ります。
