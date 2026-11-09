---
title: 其他 Fetch 平台（FaaS 模式）
description: 在任何支持 Fetch Request/Response 的平台上用 hub.fetch 和 Postgres 运行 hub：Netlify Functions、Deno、Bun 以及其他 Serverless 托管平台。说明平台必须支持什么，并提供完整文件、环境变量、部署步骤、验证清单和常见问题。
---

`hub.fetch(request)` 就是一个普通的 Fetch handler：传入 `Request`，返回 `Response`，只用 Web API。任何能运行 Fetch handler、并能以流式返回响应的平台，都可以用 FaaS 模式托管 hub。本页给出通用做法，并以 Netlify Functions 和 Bun / Deno 为例。Vercel 和 Cloudflare Workers 请看各自的页面：[Vercel 上的 Next.js](/docs/zh-cn/deploy/vercel/)、[Cloudflare Workers](/docs/zh-cn/deploy/cloudflare-workers/)。

:::note[状态]
hub 在这些平台上运行时，用的是和 Vercel、Workers 相同的 `hub.fetch`，但 Uncage 团队并没有逐个平台做端到端验证。按下面的清单检查，几分钟就能知道你的平台行不行。
:::

:::caution[Netlify：时间上限较短]
Netlify 的文档写明**流式函数的执行时间上限是 60 秒**（每个流式响应最大 20 MB）。hub 可以在这个限制内工作，但有几点要注意：把 hub 的 `stream.maxDurationMs` 设为 `50000` 左右（下面的示例 `hub.ts` 从 `UNCAGE_STREAM_MAX_MS` 读取它；流每约 50 s 轮换一次，所以重连和函数调用次数都会比 Vercel 多），并让 `toolTimeoutMs` 远低于 60 s（例如 `40_000`），因为每次网站工具调用都必须在一次函数调用（invocation）内完成。如果你的工具需要更长时间，请使用 [Vercel](/docs/zh-cn/deploy/vercel/) 或[传统模式](/docs/zh-cn/deploy/node/)。
:::

## 前提条件

平台必须：

1. **以流式返回响应**，不做缓冲：守护进程的流（`application/x-ndjson`）和浏览器事件（`text/event-stream`）会持续几分钟逐行发送。
2. **允许一个请求至少运行约 30 s**，最好能运行几分钟。把 `stream.maxDurationMs` 设在上限以下。每次网站工具调用也都在一个请求里执行，所以 `toolTimeoutMs` 也必须放得进去。
3. **能访问 Postgres**，通过 `pg` 或与 pg 兼容的 `Pool`（Neon 的 `@neondatabase/serverless` 里的 `Pool` 可以；只走 HTTP 的查询函数不行，因为 hub 需要事务）。
4. 能告诉你**客户端 IP**（通过请求头或上下文字段），用于按 IP 限流。

**强烈推荐**：提供 `waitUntil(promise)` 钩子。工具调用在它之下运行，这样连接断开也不会把 handler 中途切断，维护任务和清理也能在响应之后进行。此外最好有定时任务功能（用于调用维护端点）。

如果平台禁止在请求之间共享 socket（像 Workers 那样），就用 `fetchOnce` 为每个请求创建 hub，做法见 [Workers 页面](/docs/zh-cn/deploy/cloudflare-workers/#代码)。

```sh
npm i @uncage/hub pg
npm i -D @types/pg
```

## 代码

hub 在每个实例（进程或 isolate）中创建一次，由它处理的所有请求复用：

```ts title="hub.ts"
import { createHub, postgresCluster, postgresHubStore, type Hub, type HubUser } from '@uncage/hub';
import pg from 'pg';

/** Your sign-in: verify the session cookie of a request. Replace the body. */
async function getUser(req: Request): Promise<HubUser | null> {
  const cookie = req.headers.get('cookie') ?? '';
  // Look the session cookie up in your session store here.
  return cookie.includes('session=') ? { id: 'user-123', name: 'Ada' } : null;
}

async function createAppHub(): Promise<Hub> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  pool.on('error', (err) => console.error('postgres pool error:', err.message));
  const ipHeader = process.env.CLIENT_IP_HEADER?.toLowerCase();
  const publicUrl =
    process.env.PUBLIC_URL ?? (process.env.NODE_ENV === 'production' || process.env.VERCEL ? undefined : 'http://localhost:3000');
  if (!publicUrl) throw new Error('PUBLIC_URL is not set: set it to your site’s https:// origin.');
  return createHub({
    publicUrl, // what users open; localhost only for local development
    getUser,
    store: await postgresHubStore({ pool }),
    cluster: postgresCluster({ pool }),
    sessionStorage: 'site',
    // Below the platform's request time limit (default 250 s).
    stream: { maxDurationMs: Number(process.env.UNCAGE_STREAM_MAX_MS) || 250_000 },
    ...(ipHeader ? { rateLimits: { clientIp: (req: Request) => req.headers.get(ipHeader) ?? undefined } } : {}),
    ...(process.env.CRON_SECRET ? { maintenance: { secret: process.env.CRON_SECRET } } : {}),
  });
}

let hub: Promise<Hub> | undefined;

/** The hub of this instance; a failed start (database briefly down) is retried on the next request. */
export function getHub(): Promise<Hub> {
  const p = (hub ??= createAppHub());
  p.catch(() => {
    if (hub === p) hub = undefined;
  });
  return p;
}
```

### Netlify Functions

```ts title="netlify/functions/uncage.ts"
import { getHub } from '../../hub.ts';

/** The fields of Netlify's function context used here. */
interface NetlifyContext {
  ip: string;
  waitUntil(p: Promise<unknown>): void;
}

export default async (req: Request, context: NetlifyContext): Promise<Response> => {
  const hub = await getHub();
  return hub.fetch(req, { clientIp: context.ip, waitUntil: (p) => context.waitUntil(p) });
};

export const config = { path: '/api/uncage/*' };
```

### Bun 或 Deno（长期运行的 Fetch 服务器）

两者都会运行一个默认导出带有 `fetch` handler 的文件：`bun server.ts`（Bun 从导出中读取 `port`）或 `deno serve --port 3000 server.ts`。进程会一直运行，所以 hub 的生命周期与进程相同：

```ts title="server.ts"
import { getHub } from './hub.ts';

/** Bun passes its server as the second argument, `deno serve` a connection info object. */
interface BunServer {
  requestIP(req: Request): { address: string } | null;
}
interface DenoServeInfo {
  remoteAddr: { hostname: string };
}

function clientIpOf(req: Request, second: unknown): string | undefined {
  const s = second as Partial<BunServer & DenoServeInfo> | undefined;
  if (typeof s?.requestIP === 'function') return s.requestIP(req)?.address;
  return s?.remoteAddr?.hostname;
}

export default {
  port: 3000,
  async fetch(req: Request, second?: unknown): Promise<Response> {
    if (new URL(req.url).pathname.startsWith('/api/uncage/')) {
      const hub = await getHub();
      // The socket address; behind a proxy set CLIENT_IP_HEADER instead (it wins, see hub.ts).
      const clientIp = clientIpOf(req, second);
      return hub.fetch(req, clientIp ? { clientIp } : {});
    }
    return new Response('Your website');
  },
};
```

你还需要 `/device` 审批页（只有登录用户能访问，永远不允许被嵌入框架，由来自你自己源的 POST 做决定）。它调用 `hub.lookupDevice`、`hub.approveDevice` 和 `hub.denyDevice`；[Workers 页面](/docs/zh-cn/deploy/cloudflare-workers/#代码)里有一个不依赖框架的版本（`devicePage`），可以拿来改；规则见[认证与设备授权](/docs/zh-cn/guides/auth-and-device-approval/)。

## 环境变量

| 变量 | 是否必填 | 含义 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | 你的 Postgres 连接串。带连接池的 URL（事务模式的 PgBouncer、Neon 的 `-pooler`）可以使用。 |
| `PUBLIC_URL` | 是 | 用户打开的确切 `https://` 源。 |
| `UNCAGE_STREAM_MAX_MS` | 平台上限低于 300 s 时 | hub 结束长响应的时间点：比平台的请求时间上限低约 10–50 s。 |
| `CLIENT_IP_HEADER` | 在代理之后时 | 携带客户端地址的请求头（例如 `x-real-ip`、`cf-connecting-ip`、`x-nf-client-connection-ip`）。只有确定每个请求都经过那个代理时才设置。 |
| `CRON_SECRET` | 可选 | 启用 `GET /api/uncage/maintenance`（需带 `Authorization: Bearer <secret>`），供平台的定时任务调用。 |

这些变量名是本页自己定的；hub 本身不读取任何环境变量。

## 部署

1. **创建数据库**，并在平台上设置 `DATABASE_URL` 和 `PUBLIC_URL`。
2. **在平台文档中查到**你所用套餐的**请求时间上限**，把 hub 的 `stream.maxDurationMs` 设在它以下（示例中为 `UNCAGE_STREAM_MAX_MS`；如果上限是 300 s 或更长，可以跳过）。
3. 按平台要求的方式**部署**（Netlify：带上面的函数运行 `netlify deploy --prod`；Bun 或 Deno：在你的主机上运行 `bun server.ts` 或 `deno serve --port 3000 server.ts`）。
4. **可选：** 安排每天带上 `CRON_SECRET` bearer 令牌调用一次 `/api/uncage/maintenance`。不安排的话，维护任务仍会在处理请求时顺带运行。

## 验证

- [ ] `curl -s https://your.site/api/uncage/agent/info` 返回 `http` 传输方式（`{"protocol":2,…,"transports":[{"kind":"http",…}]}`）。
- [ ] `curl -sN https://your.site/api/uncage/agent/stream` 很快返回 `401`（没有令牌）；这说明路由已经到达 hub。
- [ ] 连接一台电脑（`uncage setup https://your.site`，在 `/device` 上批准）：它显示为**在线**，并且在线时间超过平台的时间上限。守护进程日志里是 `http stream rotated`，而不是报错。
- [ ] 提示词的回复在对话中**边生成边显示**，而不是最后一次性出现。如果是一次性出现，说明平台缓冲了响应：这个平台无法托管 hub。
- [ ] 一次网站工具调用顺利完成。

## 常见问题

### 已知哪些平台不能用？

会把整个响应缓冲好再发送的平台，或者把请求限制在几秒内的平台。hub 需要流式响应，并且能保持打开至少约 30 s。

### 只有一个长期运行的进程，能不用 Postgres 吗？

如果你的 Fetch 服务器是一个长期运行的进程（虚拟机上的 Bun 或 Deno），那实际上就是传统模式。想用 WebSocket 和嵌入式 store，就用 Node 加 `@uncage/hub/node`（[Node 页面](/docs/zh-cn/deploy/node/)）；在其他运行时上请继续用 Postgres（嵌入式 store 和 WebSocket 服务器只在 Node 上测试过）。

### 平台的时间上限最短可以是多少？

只要 `stream.maxDurationMs` 大于几秒，hub 都能工作，但每次轮换都是一次重连，而且每次工具调用都必须在上限内完成。低于约 30 s 就不值得了。

### 504、连接被切断

有请求超过了平台上限：调低 `stream.maxDurationMs`（示例中为 `UNCAGE_STREAM_MAX_MS`），并让 `toolTimeoutMs`（默认 120 s）也低于上限。被代理或网络切断的连接没有危害：守护进程会带着游标重连，什么都不会丢失，也不会重复送达。
