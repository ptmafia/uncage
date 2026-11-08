---
title: Vercel 上的 Next.js（FaaS 模式）
description: 在 Vercel 上的 Next.js App Router route handler 中运行 hub，只需要 Postgres：toNextHandlers 配合 waitUntil 使用 after、maxDuration、维护任务的 cron、Neon 与连接池 URL。包含完整文件、环境变量、部署步骤、验证清单和常见问题。
---

在 Vercel 上，hub 运行在 Next.js 的 **route handler** 里：不需要自定义服务器，不需要 WebSocket，也不需要第二个服务。每个函数实例都是一个 hub，它们共用一个 Postgres 数据库；用户的电脑通过 **HTTP 流式传输**连接（一个长时间保持的请求，hub 会在 Vercel 的时间上限之前结束它，守护进程随即重新打开）。同样的文件在任何地方用 `next start` 也能运行。为什么用 FaaS 模式，以及它的成本：见[选择部署模式](/docs/zh-cn/start/choose-deployment-mode/)。

## 前提条件

- 部署在 Vercel 上、使用 App Router 的 Next.js **15.1 或更高版本**应用（下面的文件用到了 `next/server` 中的 `after`）。
- 一个 Vercel 能访问到的 **Postgres** 数据库：Neon、Supabase、Vercel 的 Postgres 集成，或者你自己的。它的连接串就是 `DATABASE_URL`。可以使用带连接池的 URL（Neon 的 `-pooler` 主机、PgBouncer），也推荐这么做。
- 你的应用的登录状态，既能从 `Request` 读取（hub 用），也能从 `cookies()` 读取（你的页面用）。

```sh
npm i @uncage/hub @uncage/react-ui pg zod
npm i -D @types/pg
```

## 代码

七个文件。路径相对于项目根目录。

### 识别当前登录用户

```ts title="lib/auth.ts"
import type { HubUser } from '@uncage/hub';

/**
 * Replace both functions with your real sign-in before you deploy.
 * `userFromRequest` is used by the hub (a Fetch `Request`); `currentUser` by your pages.
 */
export async function userFromRequest(_req: Request): Promise<HubUser | null> {
  return developmentUser();
}

export async function currentUser(): Promise<HubUser | null> {
  return developmentUser();
}

function developmentUser(): HubUser {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('lib/auth.ts still returns the development user: connect it to your sign-in.');
  }
  return { id: 'dev-user', name: 'Developer' };
}
```

### hub

每个函数实例一个 hub，在第一个请求时创建（这样 `next build` 永远不会连接数据库），由 route handler 和你的页面共用。

```ts title="lib/uncage-hub.ts"
import { createHub, postgresCluster, postgresHubStore, type Hub } from '@uncage/hub';
import pg from 'pg';
import { userFromRequest } from './auth.ts';

async function createAppHub(): Promise<Hub> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set: add your Postgres connection string to the project’s environment variables.');
  const publicUrl = process.env.PUBLIC_URL ?? (process.env.VERCEL ? undefined : 'http://localhost:3000');
  if (!publicUrl) throw new Error('PUBLIC_URL is not set: add your site’s https:// origin to the project’s environment variables.');
  // One small pool per function instance, shared by the store and the cluster.
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  pool.on('error', (err) => console.error('postgres pool error:', err.message)); // required for your own pool
  const store = await postgresHubStore({ pool });
  return createHub({
    publicUrl, // what users open; localhost only outside Vercel
    getUser: userFromRequest,
    store,
    cluster: postgresCluster({ pool }), // wake-ups between function instances, through Postgres
    sessionStorage: 'site',
    // End long responses (agent streams, browser events) before the route's maxDuration (300 s).
    stream: { maxDurationMs: 250_000 },
    // A site tool runs inside one request: keep its limit well inside maxDuration.
    toolTimeoutMs: 120_000,
    // Enables GET /api/uncage/maintenance for Vercel Cron (it sends Authorization: Bearer $CRON_SECRET).
    ...(process.env.CRON_SECRET ? { maintenance: { secret: process.env.CRON_SECRET } } : {}),
  });
}

const KEY = Symbol.for('my-site.uncage-hub');
type Holder = { [KEY]?: Promise<Hub> };

/** The hub of this function instance. A failed start (database briefly down) is retried on the next call. */
export function getHub(): Promise<Hub> {
  const g = globalThis as Holder;
  const hub = (g[KEY] ??= createAppHub());
  hub.catch(() => {
    if (g[KEY] === hub) delete g[KEY];
  });
  return hub;
}
```

### route handler

```ts title="app/api/uncage/[...path]/route.ts"
import { toNextHandlers } from '@uncage/hub';
import { after } from 'next/server';
import { getHub } from '../../../../lib/uncage-hub.ts';

// `after`: the hub's background work (maintenance) never delays a response.
export const { GET, POST, PATCH, DELETE } = toNextHandlers(getHub, { waitUntil: after });

/** Seconds a request may run on Vercel. The hub ends its streams earlier (stream.maxDurationMs). */
export const maxDuration = 300;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
```

`toNextHandlers` 把每个请求交给 `hub.fetch`，同时传入：

- **客户端 IP**，用于按 IP 限流：在 Vercel 上（设置了 `VERCEL` 环境变量）使用 Vercel 边缘写入 `x-real-ip` 的地址，客户端在那里无法伪造。在其他地方，请自己传入 `clientIp: (req) => …`；
- **`waitUntil`**：即 Next 的 `after`，这样维护任务会在响应之后运行，而且即使守护进程的请求断开，网站工具调用也会执行完。

### 对话页面

```tsx title="app/uncage/page.tsx"
'use client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

export default function UncagePage() {
  return (
    <div style={{ height: '100vh' }}>
      <UncageProvider>
        <AgentChat />
      </UncageProvider>
    </div>
  );
}
```

### 审批页

`uncage setup` 会把用户引导到这里批准他们的电脑。只有登录用户能访问，永远不允许被嵌入框架，用 Server Action 做决定（Next.js 只接受来自你自己源的 POST）。文件和[快速上手](/docs/zh-cn/start/quickstart-connected/#7-审批页)中的相同，只是改成了 `await getHub()`。

```tsx title="app/device/page.tsx"
import type { ApproveDeviceProps } from '@uncage/react-ui';
import { currentUser } from '../../lib/auth.ts';
import { getHub } from '../../lib/uncage-hub.ts';
import { ApprovePage } from './approve-page.tsx';

export const dynamic = 'force-dynamic';

type DeviceError = NonNullable<ApproveDeviceProps['error']>;

export default async function DevicePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code = '' } = await searchParams;
  const user = await currentUser();
  if (!user) return <p>Sign in first, then open this link again.</p>; // or redirect to your login page
  let lookup: ApproveDeviceProps['lookup'] = null;
  let error: DeviceError | undefined;
  try {
    lookup = code ? await (await getHub()).lookupDevice(code, user) : null;
  } catch (e) {
    // Unknown codes count as failed guesses; after 10 in 10 minutes lookupDevice throws `rate_limited`.
    const err = e as { code?: string; message?: string };
    error = { code: err.code === 'rate_limited' ? 'rate_limited' : 'internal_error', message: err.message ?? 'Could not check this code.' };
  }
  return <ApprovePage code={code} lookup={lookup} initialError={error} />;
}
```

```ts title="app/device/actions.ts"
'use server';
import { currentUser } from '../../lib/auth.ts';
import { getHub } from '../../lib/uncage-hub.ts';

export type DecideResult = { result: 'ok' | 'not_found' | 'expired' } | { error: { code: string; message: string } };

/** A Server Action: a POST that Next.js only accepts from this site's own Origin. */
export async function decide(code: string, approve: boolean): Promise<DecideResult> {
  const user = await currentUser();
  if (!user) return { error: { code: 'unauthorized', message: 'Sign in again.' } };
  try {
    const hub = await getHub();
    return { result: await (approve ? hub.approveDevice(code, user) : hub.denyDevice(code, user)) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { error: { code: err.code ?? 'internal_error', message: err.message ?? 'Failed' } };
  }
}
```

```tsx title="app/device/approve-page.tsx"
'use client';
import { ApproveDevice, type ApproveDeviceProps, type ApproveDeviceState } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';
import { useState } from 'react';
import { decide } from './actions.ts';

export function ApprovePage({
  code,
  lookup,
  initialError,
}: Pick<ApproveDeviceProps, 'code' | 'lookup'> & { initialError?: ApproveDeviceProps['error'] }) {
  const [state, setState] = useState<ApproveDeviceState>('idle');
  const [error, setError] = useState<ApproveDeviceProps['error']>(initialError);
  const act = async (approve: boolean) => {
    setState(approve ? 'approving' : 'denying');
    setError(undefined);
    const r = await decide(code, approve);
    if ('error' in r) {
      setState('idle'); // the buttons stay enabled for a retry
      setError(r.error as ApproveDeviceProps['error']);
    } else {
      setState(r.result === 'ok' ? (approve ? 'approved' : 'denied') : r.result);
    }
  };
  return <ApproveDevice code={code} lookup={lookup} state={state} error={error} onApprove={() => void act(true)} onDeny={() => void act(false)} />;
}
```

### 响应头和 cron

```ts title="next.config.ts"
import type { NextConfig } from 'next';

const config: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
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

```json title="vercel.json"
{ "crons": [{ "path": "/api/uncage/maintenance", "schedule": "0 4 * * *" }] }
```

维护任务（按保留期清理、把实例已经挂掉的工具调用标为失败）也会在普通请求中通过 `after` 自动运行，所有实例加起来最多每分钟一次。cron 是为安静时段准备的兜底。Vercel Hobby 每天只允许运行一次；Pro 可以每小时甚至更频繁地运行。

## 环境变量

在 Vercel 项目里（Settings → Environment Variables）为 Production 和 Preview 设置，`next dev` 则写在 `.env.local` 里。

| 变量 | 是否必填 | 含义 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | 你的 Postgres 连接串。带连接池的 URL（Neon 的 `-pooler`、事务模式的 PgBouncer）可以使用。hub 会在第一个请求时建表。 |
| `PUBLIC_URL` | 是 | 用户打开的确切源，例如 `https://app.example.com`（你的生产域名，不是预览 URL）。它会写进安装和 setup 命令。 |
| `CRON_SECRET` | 推荐 | 一个随机字符串（`openssl rand -hex 32`）。Vercel Cron 会以 `Authorization: Bearer …` 发送它；只有设置了它，hub 的 `/maintenance` 端点才存在。 |
| 你的认证密钥 | 是 | `lib/auth.ts` 需要的任何东西。 |

## 部署

1. **创建数据库。** 例如通过 Vercel Marketplace 创建 Neon（它会替你设置 `DATABASE_URL`），或者任意 Postgres 14+。选一个靠近 Vercel 函数所在区域的地方：每次轮询都是一次往返。
2. **设置**上面的**环境变量**。
3. **部署**：推送到关联的 Git 仓库，或者运行 `npx vercel --prod`。
4. **打开你网站的** `/uncage`，连接一台电脑，然后对照下面的清单逐项检查。

想先在自己的电脑上试试：用本地 Postgres 运行 `next build && next start`（`docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=uncage postgres:16-alpine`，以及 `DATABASE_URL=postgres://postgres:uncage@localhost:5432/postgres`）。

## 验证

把 `https://your.site` 换成你的 `PUBLIC_URL`。

- [ ] `curl -s https://your.site/api/uncage/agent/info` 只列出 `http` 传输方式：

  ```json
  {"protocol":2,"minAgentVersion":"0.3.0","transports":[{"kind":"http","url":"https://your.site/api/uncage/agent"}]}
  ```

- [ ] `curl -s https://your.site/api/uncage/install.sh | head -2` 输出 `#!/usr/bin/env bash` 和 `# Uncage installer…`。
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://your.site/api/uncage/maintenance` 输出 `401`（设置了 `CRON_SECRET` 时；没设置则是 `404`）。带上密钥，`curl -s -H "Authorization: Bearer $CRON_SECRET" https://your.site/api/uncage/maintenance` 返回 `{"ran":true,…}`（如果过去一分钟内已有其他实例运行过，则是 `"ran":false`）。
- [ ] 从 `/uncage` 连接一台电脑（页面会显示要运行的命令；在 `/device` 上批准验证码）。几秒内它显示为**在线**。
- [ ] 发送一条提示词。回复以流式输出。守护进程的日志（在终端里运行 `uncage agent`，或查看 `~/.uncage/logs/agent.log`）大约每 250 s 出现一次 `http stream rotated`，流轮换前后对话都能正常进行。
- [ ] Vercel 的函数日志里，`/api/uncage/agent/stream` 没有 `504`。流在 300 s 之前以 200 状态结束。

## 常见问题

### 出现 504 错误（`FUNCTION_INVOCATION_TIMEOUT`）

有请求运行得比 `maxDuration` 更久。让 **`stream.maxDurationMs` 低于 `maxDuration`**，留出约 50 s 余量：`maxDuration = 300` → `250_000`（默认值）。如果你调低了 `maxDuration`（比如 60），也要相应调低 `stream.maxDurationMs`（至少低 `10_000`）。Pro 套餐可以把 `maxDuration` 提高到 800；你可以随之提高 `stream.maxDurationMs`，但收益不大：一次轮换只是多一次重连。

### `maxDuration`、`stream.maxDurationMs` 和 `toolTimeoutMs` 的区别

- `maxDuration`（秒，写在 `route.ts` 里）是 Vercel 对这个路由所有请求的硬性上限。
- `stream.maxDurationMs` 是 hub 自己结束长响应（守护进程的流和浏览器的事件流）的时间点，好让客户端干净地重连。它必须低于 `maxDuration`。
- `toolTimeoutMs` 是一个网站工具 handler 最多能运行多久。每次工具调用都在守护进程发来的一个请求中处理，并运行在 `after`（或 Vercel 请求上下文的 `waitUntil`）之下，所以请求断开不会让它停下；但这部分工作仍受 `maxDuration` 约束，因此 `toolTimeoutMs`（包括其中的文件拉取）必须放得进 `maxDuration`。如果 Vercel 在 handler 执行中途停止了函数，这次调用会以“Site tool "<name>" timed out on the website. Please try again.”失败，并且不会重试（最多执行一次）。

### 超过约 4 MB 的附件发送失败

Vercel 会在 hub 看到请求之前，用它自己的 `413` 拒绝超过约 4.5 MB 的请求体。hub 本身接受 10 MiB。除非你先检查 `POST /api/uncage/sessions/:id/attachments` 的 `Content-Length`，并按 hub 的 `attachment_too_large` 格式返回，否则用户只会看到一个笼统的错误；参考演示的 [route handler](https://github.com/ptmafia/uncage/blob/main/examples/connected-demo/app/api/uncage/%5B%5B...path%5D%5D/route.ts) 就是这样做的，上限设为 4 MB。守护进程的流量不受影响：守护进程每个请求最多发送 1 MB，拉取文件也是分块进行。

### 网速慢时上传以 `400` 失败

请求体必须在 `bodyTimeoutMs`（默认 30 s）内传完。如果你的用户要通过慢速网络上传附件，就调高它（`bodyTimeoutMs: 120_000`），但要保持在 `maxDuration` 以下。

### Neon：用哪个驱动？

用 `pg`（如上）或者 Neon 的 `@neondatabase/serverless` 里的 **`Pool`**（`postgresHubStore({ pool })` 两者都接受）。不要用只走 HTTP 的 `neon()` 函数：hub 需要在同一个连接上执行事务。带连接池的 `-pooler` URL 没问题：hub 的迁移使用事务级锁，在事务模式的连接池之后也能正常工作。

### Neon 的免费套餐会休眠吗？

只要还有电脑在线或者有函数实例处于热状态，就不会：打开的守护进程流和 `postgresCluster` 每 0.3 到 2 s 轮询一次。在有用户连接期间，请按常驻计算资源来做预算，或者参阅 [FaaS 模式的成本](/docs/zh-cn/start/choose-deployment-mode/#faas-模式的成本)。

### 需要 Redis 吗？

不需要。实例很多时，可以加上它（`cluster: redisCluster({ url: process.env.REDIS_URL! })`，需要安装 `ioredis`）来降低延迟、减少数据库轮询。Upstash Redis 只要支持基于 TCP 的 Redis 协议（`rediss://`）就能用。

### 在另一层代理之后的限流

`toNextHandlers` 读取 Vercel 边缘设置的 `x-real-ip`。如果 Vercel 前面还有别的代理或 CDN，这个请求头里就是那个代理的地址：用你的代理的客户端 IP 请求头传入 `toNextHandlers(getHub, { waitUntil: after, clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined })`。

### 用户看到“需要更新守护进程”

他们的电脑运行的是 0.3 之前的守护进程，无法通过 HTTP 流式传输连接。页面会显示修复方法：`npm i -g @uncage/cli@latest`，然后再运行一次 setup 命令。见[故障排查](/docs/zh-cn/reference/troubleshooting/#需要更新守护进程--426-upgrade_required)。

### 网站工具的 handler 能运行好几分钟吗？

在 Vercel 上不行：它运行在一个请求里，受 `maxDuration` 限制。把耗时的工作作为后台任务启动，返回一个 id，让模型用第二个工具来查询进度；或者用[传统模式](/docs/zh-cn/deploy/node/)托管 hub。
