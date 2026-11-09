---
title: Cloudflare Workers（FaaS モード）
description: Hyperdrive経由のPostgresを使い、ネイティブのCloudflare Workerでハブを動かす方法を説明します。fetchOnceによるリクエストごとのハブ、ctx.waitUntil、cf-connecting-ip、pg用のnodejs_compat、メンテナンス用のCron Triggerについて、完全なファイル、環境設定、デプロイ手順、確認チェックリスト、FAQとともに解説します。
---

Workerは、I/Oを行うオブジェクト（データベースのソケット）をリクエストをまたいで保持できません。そのためWorkersでは、ハブを**リクエストごとに**作成します。`fetchOnce`は新しいPostgresのプールの上にハブを作り、リクエストを処理し、レスポンスが（ストリームも含めて）完了した時点で両方を閉じます。リクエストより長く存続する必要があるものは、すべて**Hyperdrive**経由で接続するPostgresに保存されます。ユーザーのコンピュータはHTTPストリーミングで接続します。FaaS モードを選ぶ理由については、[デプロイモードを選ぶ](/docs/ja/start/choose-deployment-mode/)を参照してください。

:::note[ステータス]
この構成は、リポジトリの[`examples/connected-cloudflare`](https://github.com/ptmafia/uncage/tree/main/examples/connected-cloudflare)で、実際のUncageエージェントを使って`wrangler dev`（workerd）上で動作しています。デプロイ済みのWorkerでのエンドツーエンドの動作は、Uncageチームではまだ検証していません。試した結果をぜひお知らせください。
:::

## 前提条件

- Cloudflareのアカウントと、`wrangler` 4.158以降（`npm i -D wrangler`）。それより古いバージョンは、以下の`compatibility_date`を受け付けません。
- Cloudflareから接続できる**Postgres**データベース（Neon、Supabase、自前のもの）と、それに対する**Hyperdrive**の設定。ローカルでは任意のPostgres（Dockerなど）を使えます。
- Worker内で`Request`から読み取れるサイトのサインイン情報（検証可能なセッションCookie）。

```sh
npm i @uncage/hub pg
npm i -D wrangler @types/pg
```

## コード

ファイルは4つです。

```toml title="wrangler.toml"
name = "my-site"
main = "src/worker.ts"
compatibility_date = "2026-10-01"
# For the pg driver only (TCP sockets); @uncage/hub itself uses Web APIs only.
compatibility_flags = ["nodejs_compat"]

[vars]
PUBLIC_URL = "http://localhost:8787" # set your deployed origin before going live

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<your Hyperdrive id>" # wrangler hyperdrive create … --caching-disabled prints it
localConnectionString = "postgres://postgres:uncage@127.0.0.1:5432/postgres" # used by wrangler dev

# Maintenance (retention cleanup) once a day; requests also run it opportunistically.
[triggers]
crons = ["0 4 * * *"]
```

```ts title="src/auth.ts"
import type { HubUser } from '@uncage/hub';
import type { Env } from './hub.ts';

/**
 * Your sign-in: the user a request belongs to, or null. Replace the body with a real check of
 * your session cookie, for example a signed token verified with crypto.subtle, or a lookup in
 * your session table. Until then, only local development (wrangler dev) has a user.
 */
export async function userFromRequest(req: Request, env: Env): Promise<HubUser | null> {
  const local = ['localhost', '127.0.0.1'].includes(new URL(req.url).hostname);
  if (local && env.PUBLIC_URL.startsWith('http://localhost')) return { id: 'dev-user', name: 'Developer' };
  return null;
}
```

```ts title="src/hub.ts"
import { createHub, postgresCluster, postgresHubStore, type Hub } from '@uncage/hub';
import pg from 'pg';
import { userFromRequest } from './auth.ts';

export interface Env {
  /** Hyperdrive binding (wrangler.toml); wrangler dev uses its localConnectionString. */
  HYPERDRIVE: { connectionString: string };
  /** The Worker's public origin, e.g. https://my-site.example.workers.dev. */
  PUBLIC_URL: string;
}

/** A pool for one request: Workers forbid reusing sockets across requests. At most 5 connections. */
export function newPool(env: Env): pg.Pool {
  const pool = new pg.Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
  // workerd closes a finished request's sockets; pg reports that on idle clients. Log anything else.
  pool.on('error', (err) => {
    if (!/socket has been closed/i.test(err.message)) console.error('postgres pool error:', err.message);
  });
  return pool;
}

/** The hub for one request on `pool`, and the cleanup of what was built for it (the pool is the caller's). */
export async function makeHub(env: Env, pool: pg.Pool): Promise<{ hub: Hub; close(): Promise<void> }> {
  const store = await postgresHubStore({ pool });
  const cluster = postgresCluster({ pool });
  const close = async () => {
    await cluster.close();
    await store.close(); // leaves the pool open
  };
  try {
    const hub = await createHub({
      publicUrl: env.PUBLIC_URL,
      getUser: (req) => userFromRequest(req, env),
      store,
      cluster,
      sessionStorage: 'site',
    });
    return { hub, close };
  } catch (e) {
    await close();
    throw e;
  }
}
```

```ts title="src/worker.ts"
import { fetchOnce } from '@uncage/hub';
import { userFromRequest } from './auth.ts';
import { makeHub, newPool, type Env } from './hub.ts';

/** The part of Workers' ExecutionContext used here (`wrangler types` generates the full one). */
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/uncage/')) {
      return fetchOnce(
        async (defer) => {
          const pool = newPool(env);
          defer(() => pool.end()); // runs after the response, also if building the hub fails
          return makeHub(env, pool);
        },
        req,
        // Bound: an unbound ctx.waitUntil throws "Illegal invocation".
        { waitUntil: ctx.waitUntil.bind(ctx), clientIp: req.headers.get('cf-connecting-ip') ?? undefined },
      );
    }
    if (url.pathname === '/device') return devicePage(req, url, env, ctx);
    return new Response('Your website');
  },

  /** Cron Trigger: run the hub's maintenance (it skips if another instance ran it within the minute). */
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const pool = newPool(env);
    const work = (async () => {
      const { hub, close } = await makeHub(env, pool);
      try {
        console.log('uncage maintenance', JSON.stringify(await hub.maintain()));
      } finally {
        await hub.close();
        await close();
      }
    })().finally(() => pool.end());
    ctx.waitUntil(work);
  },
};

/** /device: where a signed-in user approves `uncage setup`'s code. Never framed; POST from this origin only. */
async function devicePage(req: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const user = await userFromRequest(req, env);
  if (!user) return page('<p>Sign in first, then open this link again.</p>', 401);
  if (req.method === 'POST' && req.headers.get('origin') !== url.origin) return page('<p>Cross-site request refused.</p>', 403);
  const pool = newPool(env);
  try {
    const { hub, close } = await makeHub(env, pool);
    try {
      if (req.method === 'POST') {
        const form = await req.formData();
        const code = String(form.get('code') ?? '');
        const approve = form.get('decision') === 'approve';
        const result = approve ? await hub.approveDevice(code, user) : await hub.denyDevice(code, user);
        if (result === 'ok') return page(approve ? '<p>Approved. You can close this tab.</p>' : '<p>Denied.</p>');
        return page(`<p>This code is ${result === 'expired' ? 'expired' : 'unknown'}. Run <code>uncage setup</code> again.</p>`, 410);
      }
      const code = url.searchParams.get('code') ?? '';
      const info = code ? await hub.lookupDevice(code, user) : null;
      if (!info) return page('<p>Unknown or expired code. Run <code>uncage setup</code> again.</p>', 404);
      const repair = info.repairsMachine ? `<p>This re-pairs <b>${esc(info.repairsMachine.name)}</b>.</p>` : '';
      return page(
        `<form method="post"><p>Connect <b>${esc(info.name ?? 'a computer')}</b> to your account? Check that it shows the code <b>${esc(code)}</b>.</p>${repair}` +
          `<input type="hidden" name="code" value="${esc(code)}"><button name="decision" value="approve">Approve</button> <button name="decision" value="deny">Deny</button></form>`,
      );
    } finally {
      await hub.close();
      await close();
    }
  } catch (e) {
    // Unknown codes count as failed guesses: after 10 in 10 minutes the hub refuses with rate_limited.
    if ((e as { code?: string }).code === 'rate_limited') return page('<p>Too many attempts. Try again in a few minutes.</p>', 429);
    console.error('device page failed:', e);
    return page('<p>Something went wrong. Try again shortly.</p>', 500);
  } finally {
    ctx.waitUntil(pool.end());
  }
}

function page(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Connect your computer</title>${body}`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' },
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
```

重要な点は次のとおりです。

- **リクエストごとに1つのハブ**。`fetchOnce(create, req, …)`は、リクエストのたびに`create(defer)`を呼び出します。何かを開いたら、その都度`defer`で後始末を登録し、ハブまたは`{ hub, close }`を返します。レスポンスボディが完了するかキャンセルされた後（それより前には実行しないため、ストリームは動き続けます）、`hub.close()`、`close`、`defer`で登録した後始末の順に実行します。
- **マイグレーションの確認はisolateごとに1回です**。新しいプールのコストは軽い`SELECT max(id)`が1回だけで、ロックもDDLもありません。
- **`waitUntil: ctx.waitUntil.bind(ctx)`を必ず渡します**。これにより、リクエストが切れたサイトツールの呼び出し、ハブのバックグラウンド処理、後始末のためにisolateが生かされます。
- **`clientIp`は`cf-connecting-ip`から取得します**。これはCloudflareが設定するヘッダーで、IPごとのレート制限に使います。
- サインイン処理は`getUser`（`src/auth.ts`）に書きます。リポジトリの例には、誰でも任意のユーザーになれるデモ用のサインインがあります。これは公開ホストでは動作しないようになっており、実際のサイトにコピーするものでは**ありません**。

## 環境変数

| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `HYPERDRIVE` | Hyperdriveのバインディング | Hyperdrive経由のPostgres（`wrangler.toml`の`[[hyperdrive]]`）。`wrangler dev`では、代わりに`localConnectionString`か、環境変数`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`を使います。 |
| `PUBLIC_URL` | var | ユーザーが開く正確なオリジン（`https://…`。`http://`はlocalhostの場合のみ可）。インストールコマンドとセットアップコマンドに埋め込まれます。 |
| 認証用のシークレット | secret | `src/auth.ts`が必要とするもの。`wrangler secret put <NAME>`で設定します。`wrangler dev`用には`.dev.vars`に記述します。 |

`CRON_SECRET`は不要です。Cron Triggerは`scheduled`を直接呼び出します（HTTP経由のcronを使いたい場合は、`createHub`で`maintenance: { secret }`を設定し、`Authorization: Bearer <secret>`を付けて`GET /api/uncage/maintenance`を呼び出します）。

## デプロイ

1. **まずローカルで動かします**。`localConnectionString`に合わせてPostgresを起動してから、次を実行します。

   ```sh
   docker run -d --name pg -p 5432:5432 -e POSTGRES_PASSWORD=uncage postgres:16-alpine
   npx wrangler dev        # http://localhost:8787
   ```

2. **Hyperdriveの設定を作成します**。クエリキャッシュは無効にし（ハブは同じクエリを繰り返してポーリングするため、常に最新の結果が必要です）、そのIDを`wrangler.toml`に記入します。

   ```sh
   npx wrangler login
   npx wrangler hyperdrive create my-site-db --connection-string="postgres://user:password@host:5432/db" --caching-disabled
   ```

3. **一度デプロイして**、WorkerのURLを確認します：`npx wrangler deploy`。
4. **`PUBLIC_URL`を設定します**。`wrangler.toml`でそのURL（またはカスタムドメイン）を指定し、`wrangler secret put`で認証用のシークレットを追加して、もう一度デプロイします。
5. リンクを誰かに送る前に、**実際のサインイン処理を`src/auth.ts`に組み込みます**。

## 動作を確認する

`https://my-site.example.workers.dev`は実際の`PUBLIC_URL`に置き換えてください（`wrangler dev`の場合は`http://localhost:8787`を使います）。

- [ ] `curl -s https://my-site.example.workers.dev/api/uncage/agent/info`の結果に、`http`だけが含まれる。

  ```json
  {"protocol":2,"minAgentVersion":"0.3.0","transports":[{"kind":"http","url":"https://my-site.example.workers.dev/api/uncage/agent"}]}
  ```

- [ ] `curl -s https://my-site.example.workers.dev/api/uncage/install.sh | head -2`を実行すると、インストーラーの先頭の行が表示される。
- [ ] `npx wrangler tail`を実行した状態でコンピュータを接続する（`uncage setup https://my-site.example.workers.dev`を実行し、`/device`で承認する）と、エラーが出ず、コンピュータがオンラインと表示される。
- [ ] サイトツールを呼び出すプロンプトを実行すると、ツールのステップが完了する。
- [ ] `npx wrangler deploy --dry-run --outdir dist`がエラーなくバンドルできる（`@uncage/hub`のルートのエントリはWeb標準のAPIだけを使い、`@uncage/hub/node`はここでは一切インポートされません。`nodejs_compat`が必要なのは`pg`だけです）。

## FAQ

### リクエストごとに新しいハブを作るのは遅くないですか？

Workersではリクエスト間でソケットを共有できないため、共有のプールは使えません。ハブの作成は軽い処理です。isolateの最初のリクエストの後はマイグレーションが走らず（`SELECT max(id)`が1回だけ）、Hyperdriveが実際のデータベース接続をウォーム状態に保ちます。リポジトリの例では、workerd上でストリームを経由するコマンドの往復に約350msかかりました。

### Workersでサイトツールはちょうど1回実行されますか？

Workersでは、ハブは各ツール呼び出しを`fetchOnce`に渡した`waitUntil`のもとで実行します。そのため、POSTが切れてもハンドラーは止まらず、結果が保存され、エージェントの再送でその結果を受け取れます（ちょうど1回）。ただしWorkersが`waitUntil`の処理を生かしておくのは、クライアントの切断後約30秒間だけです。その時点でまだ実行中のハンドラーはキャンセルされます。そのリース（`toolTimeoutMs` + 10秒）が切れると、呼び出しは「Site tool "<name>" timed out on the website. Please try again.」というエラーで失敗し、再実行されることはありません（最大1回）。`waitUntil`を渡さない場合は、POSTが切れるたびにこうなります。したがって、必ず`waitUntil: ctx.waitUntil.bind(ctx)`を渡し、ハンドラーは30秒より十分短く保ち、可能な限り冪等にしてください。

### 504が出る、またはストリームが早く切れます

HTTPリクエストを処理するWorkerには、クライアントが接続している間は実時間（wall-clock）の制限がなく、I/Oの待ち時間もCPU時間に含まれません。そのため、デフォルトの`stream.maxDurationMs`（250秒）で問題ありません。プランや前段のプロキシが長時間のリクエストをそれより早く切る場合は、`stream.maxDurationMs`をその制限より短くしてください。

### Hyperdriveを使わずにNeonやSupabaseを使えますか？

Hyperdriveを使ってください。Workerの近くで接続をプールしてくれます。作成時には`--caching-disabled`を指定します。ハブは同じクエリを繰り返してポーリングするため最新の結果が必要ですが、Hyperdriveのクエリキャッシュは古い結果を返してしまうためです。Hyperdriveを使わない場合は、Neonの`@neondatabase/serverless`の`Pool`（WebSocket）も`postgresHubStore({ pool })`で使えます。HTTP専用の`neon()`関数は使えません（ハブは1つの接続上でトランザクションを必要とします）。

### なぜ`nodejs_compat`が必要なのですか？

`pg`のためだけです。`pg`は`cloudflare:sockets`経由でTCPソケットを開きます。`@uncage/hub`のルートのエントリはWeb APIだけを使い、`@uncage/hub/node`（WebSocketサーバー、PGlite）がバンドルされることはありません。

### この構成でコンピュータはWebSocketを使えますか？

この構成では使えません。Workerには、エージェントのWebSocketを受け付けるものがありません（Durable Objectsが必要になります）。ハブは`http`だけを提供し、エージェントはそれを使います。0.3より古いエージェントがWebSocketで接続しようとすると`426 upgrade_required`が返り、サイトには「Agent update needed」（エージェントの更新が必要）と表示されます。

### 別のプロキシの背後でのレート制限は？

`cf-connecting-ip`は、Cloudflareから見たクライアントのアドレスです。Cloudflareの前段に別のプロキシがある場合は、代わりにそのプロキシのクライアントIPヘッダーを読んでください。
