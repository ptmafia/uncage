---
title: Cloudflare Workers（FaaS 模式）
description: 在原生 Cloudflare Worker 中运行 hub，经由 Hyperdrive 使用 Postgres：用 fetchOnce 为每个请求创建一个 hub，ctx.waitUntil、cf-connecting-ip、为 pg 开启 nodejs_compat、用 Cron Trigger 运行维护任务。包含完整文件、环境配置、部署步骤、验证清单和常见问题。
---

Worker 不能在请求之间保留执行 I/O 的对象（数据库 socket），所以在 Workers 上，hub 是**按请求创建**的：`fetchOnce` 在一个新的 Postgres 连接池上建好 hub，处理这个请求，等响应结束后（包括流式响应）再把两者都关掉。所有需要比请求活得更久的东西都存在 Postgres 里，通过 **Hyperdrive** 访问。用户的电脑通过 HTTP 流式传输连接。为什么用 FaaS 模式：见[选择部署模式](/docs/zh-cn/start/choose-deployment-mode/)。

:::note[状态]
这套配置已经在 `wrangler dev`（workerd）上配合真实的 Uncage 守护进程跑通，代码在仓库的 [`examples/connected-cloudflare`](https://github.com/ptmafia/uncage/tree/main/examples/connected-cloudflare) 中。Uncage 团队还没有对部署后的 Worker 做过端到端验证；欢迎告诉我们你的使用情况。
:::

## 前提条件

- 一个 Cloudflare 账号和 `wrangler` 4.158 或更高版本（`npm i -D wrangler`）。更早的版本不接受下面的 `compatibility_date`。
- 一个 Cloudflare 能访问到的 **Postgres** 数据库（Neon、Supabase 或你自己的），以及为它创建的 **Hyperdrive** 配置。本地开发时，任意 Postgres 都可以（例如在 Docker 里）。
- 你网站的登录状态，能在 Worker 里从 `Request` 读取（一个你能校验的会话 cookie）。

```sh
npm i @uncage/hub pg
npm i -D wrangler @types/pg
```

## 代码

四个文件。

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

要点：

- **每个请求一个 hub。** `fetchOnce(create, req, …)` 对每个请求都调用 `create(defer)`。每打开一样东西，就用 `defer` 注册对应的清理；返回 hub，或者 `{ hub, close }`。等响应体结束或被取消之后（绝不会更早，所以流不受影响），它会依次运行 `hub.close()`、`close` 和用 `defer` 注册的清理。
- **每个 isolate 只检查一次迁移**：新连接池只需一次很轻的 `SELECT max(id)`，不加锁，也不执行 DDL。
- **`waitUntil: ctx.waitUntil.bind(ctx)`** 让 isolate 保持存活，以便完成请求已断开的网站工具调用、hub 的后台工作和清理。请始终传入它。
- **`clientIp` 取自 `cf-connecting-ip`**（由 Cloudflare 设置），用于按 IP 限流。
- 你的登录逻辑写在 `getUser`（`src/auth.ts`）里。仓库示例带有一个演示用的登录，任何人都可以冒充任何用户；它在公网主机上会拒绝工作，**绝不能**照搬到真实网站中。

## 环境变量

| 名称 | 类型 | 含义 |
| --- | --- | --- |
| `HYPERDRIVE` | Hyperdrive 绑定 | 通过 Hyperdrive 访问的 Postgres（`wrangler.toml` 中的 `[[hyperdrive]]`）。`wrangler dev` 则使用 `localConnectionString`，或者 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` 环境变量。 |
| `PUBLIC_URL` | var | 用户打开的确切源，`https://…`（只有 localhost 可以用普通的 `http://`）。它会写进安装和 setup 命令。 |
| 你的认证密钥 | secret | `src/auth.ts` 需要的任何东西：`wrangler secret put <NAME>`。`wrangler dev` 时写在 `.dev.vars` 里。 |

不需要 `CRON_SECRET`：Cron Trigger 会直接调用 `scheduled`。（如果你更想用 HTTP cron，就在 `createHub` 中设置 `maintenance: { secret }`，并带上 `Authorization: Bearer <secret>` 调用 `GET /api/uncage/maintenance`。）

## 部署

1. **先在本地运行。** 启动一个与 `localConnectionString` 对应的 Postgres，然后：

   ```sh
   docker run -d --name pg -p 5432:5432 -e POSTGRES_PASSWORD=uncage postgres:16-alpine
   npx wrangler dev        # http://localhost:8787
   ```

2. **创建 Hyperdrive 配置**，关闭查询缓存（hub 会反复执行相同的查询来轮询，需要拿到最新结果），并把它的 id 写进 `wrangler.toml`：

   ```sh
   npx wrangler login
   npx wrangler hyperdrive create my-site-db --connection-string="postgres://user:password@host:5432/db" --caching-disabled
   ```

3. **先部署一次**，拿到 Worker 的 URL：`npx wrangler deploy`。
4. **在 `wrangler.toml` 中把 `PUBLIC_URL`** 设为这个 URL（或你的自定义域名），用 `wrangler secret put` 添加认证密钥，然后再部署一次。
5. 在把链接发给任何人之前，**把真实的登录逻辑接入** `src/auth.ts`。

## 验证

把 `https://my-site.example.workers.dev` 换成你的 `PUBLIC_URL`（在 `wrangler dev` 下则用 `http://localhost:8787`）。

- [ ] `curl -s https://my-site.example.workers.dev/api/uncage/agent/info` 只列出 `http`：

  ```json
  {"protocol":2,"minAgentVersion":"0.3.0","transports":[{"kind":"http","url":"https://my-site.example.workers.dev/api/uncage/agent"}]}
  ```

- [ ] `curl -s https://my-site.example.workers.dev/api/uncage/install.sh | head -2` 输出安装脚本的前两行。
- [ ] 连接电脑时（`uncage setup https://my-site.example.workers.dev`，在 `/device` 上批准）运行 `npx wrangler tail`：没有报错，电脑显示在线。
- [ ] 运行一条会调用某个网站工具的提示词；工具步骤顺利完成。
- [ ] `npx wrangler deploy --dry-run --outdir dist` 打包没有报错。（`@uncage/hub` 的根入口只用 Web 标准 API，这里也从不导入 `@uncage/hub/node`；只有 `pg` 需要 `nodejs_compat`。）

## 常见问题

### 为什么每个请求都新建一个 hub？不会很慢吗？

Workers 禁止在请求之间共享 socket，所以共享连接池行不通。而新建 hub 的开销很小：一个 isolate 的第一个请求之后就不再跑迁移（只有一次 `SELECT max(id)`），Hyperdrive 则让真正的数据库连接保持预热。在 workerd 上，仓库示例测得一条命令经由流往返一次约 350 ms。

### 在 Workers 上，网站工具会恰好执行一次吗？

在 Workers 上，hub 会把每次工具调用放在你传给 `fetchOnce` 的 `waitUntil` 之下运行，所以 POST 断开不会让 handler 停下：它的结果会被存储，守护进程重发时就能拿到（恰好一次）。但客户端断开后，Workers 只会让 `waitUntil` 中的工作再存活约 30 s。超过这个时间还在运行的 handler 会被取消。等它的租期（`toolTimeoutMs` + 10 s）用完，这次调用会以“Site tool "<name>" timed out on the website. Please try again.”失败，并且不会重试（最多执行一次）。如果没有传 `waitUntil`，任何一次 POST 断开都会导致这种结果。所以：始终传入 `waitUntil: ctx.waitUntil.bind(ctx)`，让 handler 的耗时远低于 30 s，并尽量把它们做成幂等的。

### 出现 504，或者流过早被切断？

只要客户端保持连接，HTTP Worker 就没有墙钟时间限制，等待 I/O 也不计入 CPU 时间，所以默认的 `stream.maxDurationMs`（250 s）就可以。如果你的套餐或前面的代理会更早切断长请求，就把 `stream.maxDurationMs` 调到那个上限以下。

### 不用 Hyperdrive，直接用 Neon 或 Supabase？

请使用 Hyperdrive：它在靠近 Worker 的地方维护连接池。创建时加上 `--caching-disabled`：hub 会反复执行相同的查询来轮询，需要拿到最新结果，而 Hyperdrive 的查询缓存会返回过时的数据。不用 Hyperdrive 的话，Neon 的 `@neondatabase/serverless` 里的 `Pool`（基于 WebSocket）也可以配合 `postgresHubStore({ pool })` 使用；但它只走 HTTP 的 `neon()` 函数不行（hub 需要在同一个连接上执行事务）。

### 为什么需要 `nodejs_compat`？

只是为了 `pg`：它通过 `cloudflare:sockets` 打开 TCP socket。`@uncage/hub` 的根入口只用 Web API；`@uncage/hub/node`（WebSocket 服务器、PGlite）永远不会被打包进来。

### 电脑能在这里用 WebSocket 吗？

这套配置不行：Worker 里没有任何东西接受守护进程的 WebSocket（那需要 Durable Objects）。hub 只提供 `http`，守护进程也就用它。0.3 之前的守护进程如果尝试 WebSocket，会收到 `426 upgrade_required`，网站会显示“需要更新守护进程”。

### 在另一层代理之后的限流？

`cf-connecting-ip` 是 Cloudflare 看到的客户端地址。如果 Cloudflare 前面还有别的代理，请改为读取那个代理的客户端 IP 请求头。
