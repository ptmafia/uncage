---
title: 挂载 hub
description: 在 Express、Fastify、Hono、Next.js 自定义服务器或纯 node:http 中挂载 @uncage/hub 的完整 Node 服务器示例（传统模式），作为 Fetch handler 运行在 Serverless 平台上的 hub，createHub 的全部选项，以及代理配置。
---

hub 是一个 Fetch handler：`hub.fetch(request)` 处理它基础路径（默认 `/api/uncage`）下的所有请求，包括浏览器 API、设备登录、`install.sh` / `install.ps1`，以及电脑的 HTTP 流式传输。怎么挂载取决于你的网站运行在哪里（[选择部署模式](/docs/zh-cn/start/choose-deployment-mode/)）：

- **长期运行的 Node 进程（传统模式）**：就是本页。`@uncage/hub/node` 中的 `toNodeHandler(hub)` 把 `hub.fetch` 挂成 Node 中间件，`attachWebSocket(hub, server)` 在你的 HTTP 服务器上接受电脑的 WebSocket。store 用 `pgliteHubStore`，一个放在目录里的嵌入式 Postgres：不需要再运行任何其他东西。
- **Serverless 或 Fetch 平台（FaaS 模式）**：[Vercel 上的 Next.js](/docs/zh-cn/deploy/vercel/)（`toNextHandlers`）、[Cloudflare Workers](/docs/zh-cn/deploy/cloudflare-workers/)（`fetchOnce`）、[其他 Fetch 平台](/docs/zh-cn/deploy/other-fetch-platforms/)（`hub.fetch`）。这些都需要 Postgres。

下面每个示例都是一个完整的 Node.js 22+ 服务器文件。它们都从 `./auth` 导入同一个 `getSessionUser`，代表你应用的登录体系（见[认证与设备授权](/docs/zh-cn/guides/auth-and-device-approval/)）：

```ts title="auth.ts"
import type { HubUser } from '@uncage/hub';

/** Your sign-in: the user a request belongs to, or null. */
export async function getSessionUser(req: Request): Promise<HubUser | null> {
  const cookie = req.headers.get('cookie') ?? '';
  // Look the session cookie up in your session store here.
  return cookie.includes('session=') ? { id: 'user-123', name: 'Ada' } : null;
}
```

## Express

```ts title="express-server.ts"
import { createServer } from 'node:http';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import express from 'express';
import { getSessionUser } from './auth.ts';

const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
  store,
});

const app = express();
// app.set('trust proxy', 1); // behind one reverse proxy: makes req.ip the client address (rate limits)
app.use(toNodeHandler(hub)); // first, before express.json() or compression()
app.use(express.json());
app.get('/', (_req, res) => {
  res.send('Your website');
});

const server = createServer(app);
attachWebSocket(hub, server); // computers connect to ws(s)://<host>/api/uncage/agent
server.listen(3000, () => console.log('http://localhost:3000'));
```

`toNodeHandler(hub)` 只处理 `hub.basePath` 下的路径，其他请求都交给 `next()`。带前缀挂载（`app.use('/api/uncage', toNodeHandler(hub))`）也可以，它读取的是 `req.originalUrl`。

## Fastify

Fastify 会自己解析请求体，所以要给 hub 一个不带任何 body 解析器的作用域，并把原始请求交给它：

```ts title="fastify-server.ts"
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import Fastify from 'fastify';
import { getSessionUser } from './auth.ts';

const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
  store,
});
const hubHandler = toNodeHandler(hub);

const app = Fastify();
await app.register(async (scope) => {
  // Leave the request body unread: the hub streams it itself.
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser('*', (_req, _payload, done) => done(null));
  for (const url of [hub.basePath, `${hub.basePath}/*`]) {
    scope.all(url, (req, reply) => {
      reply.hijack();
      hubHandler(req.raw, reply.raw);
    });
  }
});
app.get('/', async () => 'Your website');

await app.ready();
attachWebSocket(hub, app.server);
await app.listen({ port: 3000 });
```

## Hono（Node）

使用 `@hono/node-server` 时，把 Fetch `Request` 直接交给 `hub.fetch`，并传入客户端地址用于限流：

```ts title="hono-server.ts"
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore } from '@uncage/hub/node';
import { Hono, type Context } from 'hono';
import { getSessionUser } from './auth.ts';

const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  getUser: getSessionUser,
  store,
});

const app = new Hono();
const toHub = (c: Context) => hub.fetch(c.req.raw, { clientIp: getConnInfo(c).remote.address });
app.all(hub.basePath, toHub);
app.all(`${hub.basePath}/*`, toHub);
app.get('/', (c) => c.text('Your website'));

const server = serve({ fetch: app.fetch, port: 3000 });
attachWebSocket(hub, server as Server);
```

## Next.js（自定义服务器）

想在 Next.js 应用里保持传统模式（WebSocket、嵌入式 store、不用运行数据库），就要在你自己的 Node 服务器里运行 Next.js，并把 hub 放在它旁边：route handler 无法接受 WebSocket 升级。[Connected 模式快速上手](/docs/zh-cn/start/quickstart-connected/)和 `connected-demo` 示例都是这样做的。（不用自定义服务器的话，就把 hub 挂在 route handler 里：见 [Vercel 上的 Next.js](/docs/zh-cn/deploy/vercel/)，这种做法在 `next start` 下同样可用。）

```ts title="server.ts"
import { createServer } from 'node:http';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import next from 'next';
import { getSessionUser } from './auth.ts';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);

const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  getUser: getSessionUser,
  store: await pgliteHubStore({ dataDir: './.uncage-hub' }),
});
// Pages and Server Actions (for example /device) get the hub from here.
(globalThis as Record<symbol, unknown>)[Symbol.for('my-site.uncage-hub')] = hub;
const hubHandler = toNodeHandler(hub);

const server = createServer();
const app = next({ dev, hostname: 'localhost', port, httpServer: server });
const handle = app.getRequestHandler();
await app.prepare();

server.on('request', (req, res) => {
  hubHandler(req, res, () => void handle(req, res));
});
attachWebSocket(hub, server);
if (dev) {
  const upgrade = app.getUpgradeHandler(); // hot reload
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== `${hub.basePath}/agent`) void upgrade(req, socket, head);
  });
}
server.listen(port);
```

用 `node server.ts` 启动它（Node 22.18+ 可直接运行 TypeScript），而不是 `next dev`。快速上手里给出了配套的 `package.json` 和 `tsconfig.json` 设置，以及供页面使用的带类型的 `getHub()` 辅助函数。

## 纯 `node:http`

```ts title="node-server.ts"
import { createServer } from 'node:http';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import { getSessionUser } from './auth.ts';

const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
const hub = await createHub({ publicUrl: 'http://localhost:3000', getUser: getSessionUser, store });
const hubHandler = toNodeHandler(hub);

const server = createServer((req, res) => hubHandler(req, res)); // no next(): other paths get 404
attachWebSocket(hub, server);
server.listen(3000);
```

## 检查

```sh
curl -s http://localhost:3000/api/uncage/install.sh | head -3   # public: prints the installer
curl -s http://localhost:3000/api/uncage/agent/info             # public: protocol and offered transports
curl -s http://localhost:3000/api/uncage/health                 # needs a signed-in user: 401 without
```

当这个进程里运行了 `attachWebSocket` 时，`/agent/info` 会先列出 `ws`、再列出 `http`（否则只有 `http`）。对已登录用户，`/health` 返回 `{"ok":true,"protocol":"1.0","version":"…"}`，否则返回 `401 unauthorized`。

把 `.uncage-hub/` 加进 `.gitignore`，并在生产环境中把这个目录放在持久磁盘上：已配对的电脑都存在里面。每个目录只能由一个进程使用（PGlite 会锁住它）；需要多个进程时，见[多节点](/docs/zh-cn/guides/multi-node/)。

## `createHub` 选项

`publicUrl`、`getUser` 和 `store` 是必填的。

| 选项 | 默认值 | 作用 |
| --- | --- | --- |
| `publicUrl` | （必填） | 你网站的公开源，例如 `https://app.example.com`。用于安装和 setup 命令、`/device` 链接、传输方式的 URL，以及 CSRF 源校验。必须是 `https://`（只有 `localhost`、`127.0.0.1`、`[::1]` 可以用普通的 `http://`）。 |
| `getUser(req)` | （必填） | 你的认证：已登录的浏览器请求返回 `{ id, name? }`，否则返回 `null`。 |
| `store` | （必填） | `HubStore`。单个 Node 进程用 `@uncage/hub/node` 中的 `pgliteHubStore({ dataDir })`；多节点和 FaaS 用 `postgresHubStore({ connectionString } \| { pool })`。hub 从不关闭它。 |
| `cluster` | `memoryCluster()` | `ClusterAdapter`。多节点和 FaaS 用 `redisCluster` 或 `postgresCluster`。[指南](/docs/zh-cn/guides/multi-node/) |
| `basePath` | `/api/uncage` | hub 挂载的位置。如果修改了它，要把同样的路径作为 `baseUrl` 传给 `UncageProvider`。 |
| `tools` | `[]` | 用 `defineTool` 定义的网站工具。[指南](/docs/zh-cn/guides/define-tools/) |
| `skills` | `[]` | `SkillSpec[]`。[指南](/docs/zh-cn/guides/write-skills/) |
| `selectManifest(ctx)` | 全部工具和技能 | 按运行挑选工具和技能。[指南](/docs/zh-cn/guides/select-manifest/) |
| `sessionStorage` | `'machine'` | `'site'` 会保存每段对话的副本。[指南](/docs/zh-cn/guides/site-storage/) |
| `attachmentRetentionDays` | `30` | hub 保留经网站发送的附件副本的天数（`Infinity` 表示永久保留）。被吊销电脑的附件会立即删除。[详情](/docs/zh-cn/guides/site-storage/#附件) |
| `site` | 取自 `publicUrl` 主机名的 id 和名称 | `{ id?, name? }`，配对时展示给电脑。请保持 `id` 稳定。 |
| `verificationPath` | `/device` | 你的审批页。[指南](/docs/zh-cn/guides/auth-and-device-approval/) |
| `minAgentVersion` | `0.3.0` | 更旧的守护进程会收到升级提示（`upgrade_required`）。通过 WebSocket 连接的会自行升级；在 FaaS 模式下，网站会显示“需要更新守护进程”。 |
| `cliVersionRange` | hub 的 `^<major.minor>` | `install.sh` / `install.ps1` 安装哪个版本的 `@uncage/cli`（`^0.3`、`~0.3.1`、`0.3.0` 或 `latest`）。 |
| `installScript` | 无 | 追加到安装脚本里的固定文本：CLI 安装之后的一个步骤，和/或你自己的“没有找到 agent”帮助信息。 |
| `transports` | 使用 `attachWebSocket` 时为 `['ws', 'http']`，否则为 `['http']` | 提供给守护进程的传输方式。如果由另一个进程在 `<basePath>/agent` 上提供 WebSocket，就列出 `ws`；去掉 `http` 则只提供 WebSocket。 |
| `stream` | `{ maxDurationMs: 250000 }` | 超过这个时长，hub 会结束守护进程的流和浏览器的事件流，客户端立即重连，没有空档。请保持在平台的请求时间上限以下。 |
| `polling` | `{ activeMs: 300, idleMs: 2000, activeWindowMs: 30000 }` | 守护进程的 HTTP 流轮询其 outbox 的频率：活跃时快速轮询，安静时退避到 `idleMs`。 |
| `heartbeat` | `{ pingIntervalMs: 10000, missedPings: 2 }` | 失去响应的电脑约 30 秒后显示为离线。 |
| `sseHeartbeatMs` | `15000` | 浏览器事件流上的保活注释间隔。 |
| `commandTimeoutMs` | `30000` | 浏览器请求等待电脑响应的时长。 |
| `bodyTimeoutMs` | `30000` | 如果在这个时长内没有收到任何字节，或者整个请求体用时超过这个时长的 4 倍，就以 `400` 拒绝。慢但持续的上传可以顺利完成。 |
| `logger` | 控制台 | hub 报告警告和错误的位置（`{ warn(obj, msg), error(obj, msg) }`；pino 和大多数日志库都适用）。默认用 `console.warn` 和 `console.error` 输出以 `[uncage] …` 开头的行。传入 `{ warn() {}, error() {} }` 可以静音。在 Vercel 和 Workers 上，如果 hub 没有 `cluster`（此时在线状态按实例各自保存），`toNextHandlers` 和 `fetchOnce` 会输出一次警告，见 [Serverless 托管](#serverless-托管vercelnetlifyworkers)。 |
| `toolTimeoutMs` | `120000` | 工具 handler 超过这个时长仍在运行，就以 `tool_failed` 失败。在 FaaS 模式下，请让它不超过平台的时间上限。 |
| `toolDrainMs` | `5000` | `hub.close()` 让正在运行的工具 handler 在这个时长内收尾，之后中止它们。 |
| `maxConcurrentToolCalls` | `8` | 一台电脑在一个 hub 实例上同时可以进行的工具调用数。 |
| `rateLimits` | 见下文 | 设备登录和机器令牌的防滥用限制。 |
| `maintenance` | `{ intervalMs: 60000 }` | 按保留期清理，见下文。 |

`rateLimits`：`deviceCodesPerMinute`（每个客户端 IP 20 次）、`userCodeFailures`（每个用户猜错验证码的次数上限，10 次）和 `userCodeWindowMs`（统计窗口，10 分钟）、`agentAuthFailuresPerMinute`（每个客户端 IP 每分钟 60 次缺少机器令牌或令牌错误的请求；有效的令牌永远不受限制），以及 `clientIp(req)` 和 `trustForwardedFor`（见[反向代理或负载均衡之后](#反向代理或负载均衡之后)）。超出限制时返回 `429 rate_limited`。计数存在 store 里，所以所有节点和函数实例共用同一份计数。

`maintenance` 负责删除不再需要的数据（从未得到应答的运行清单 1 h 后删除，其他 7 天后删除；附件副本在 `attachmentRetentionDays` 后删除；去重记录和已存储的工具结果 24 h 后删除；过期的 outbox 条目和设备码），并把实例在 handler 执行中途挂掉的网站工具调用标为失败。所有实例加起来，每个 `intervalMs` 最多运行一次：运行了 `attachWebSocket` 时按定时器运行，否则由请求触发（平台提供 `waitUntil` 时在响应之后运行）。`secret` 启用 `GET|POST <basePath>/maintenance`（需带 `Authorization: Bearer <secret>`），供平台的定时任务调用（Vercel Cron 就是这样发送 `CRON_SECRET` 的）。`onRun()` 在每次运行后执行你自己的清理逻辑。

返回的 `Hub` 有 `basePath`、`fetch(req, info?)`、`approveDevice`、`denyDevice`、`lookupDevice`、`revokeMachine`、`maintain()` 和 `close()`。`info` 是 `{ clientIp?, waitUntil? }`。`close()` 从不关闭 store，只有 cluster 是 hub 自己创建的时候才会关闭它；你自己创建的，请在它之后自行关闭。

## 反向代理或负载均衡之后

:::caution[上线前设置客户端 IP]
`POST <basePath>/device/code`（每次 `uncage setup` 都会调用）的限制是**每个客户端 IP 每分钟 20 次**。在反向代理、负载均衡或 CDN 后面，除非你另行告知，hub 看到的是代理的地址，而不是用户的地址。这时**所有用户共用一个限流桶**：全站一分钟内从第 21 次 setup 起，`uncage setup` 都会以 `429 rate_limited` 失败。

用下面任一种方式解决：

- Express：`app.set('trust proxy', 1)`（数字是应用前面的代理层数）。`toNodeHandler` 随后会传入 `req.ip`。
- Vercel 上的 Next.js：无需处理，`toNextHandlers` 会读取 Vercel 边缘设置的地址。Cloudflare Workers：给 `fetchOnce` 传入 `clientIp: req.headers.get('cf-connecting-ip') ?? undefined`。
- 任何服务器：`rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined }`（换成你所用平台的客户端 IP 请求头）。
- `rateLimits: { trustForwardedFor: true }`，仅当你的代理会把客户端地址追加到 `X-Forwarded-For` 时使用（hub 取最右边的一项）。
:::

- **转发 `<basePath>/agent` 上的 WebSocket 升级**（nginx：`proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`），并允许长连接（hub 每 10 秒 ping 一次）。升级失败时，守护进程会自动退回到 HTTP 流式传输，但 WebSocket 更快。
- **保留原始的 `Host`**（nginx：`proxy_set_header Host $host;`）。hub 会拿请求的 `Origin` 和 `publicUrl` 以及 `Host` 比较，以拒绝跨站 POST。
- **不要缓冲流**：`<basePath>/sessions/*/events` 上的 SSE 和 `<basePath>/agent/stream` 上的 NDJSON（nginx：`proxy_buffering off;`）。允许请求持续至少 `stream.maxDurationMs`（250 s）。
- **限流用的客户端 IP。** Express：`app.set('trust proxy', 1)`，`toNodeHandler` 会使用 `req.ip`。Fetch 风格的服务器：用 `hub.fetch(req, { clientIp })` 传入，或者传入 `rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined }`（或你所用平台的请求头）；如果你的代理会把客户端地址追加到 `X-Forwarded-For`，则用 `trustForwardedFor: true`。这些都不设置时，每个客户端都按代理的地址（或一个 `shared` 桶）计数，限制就作用于所有用户的总和。
- **TLS。** 在哪里终止都可以，但 `publicUrl` 必须是用户打开的 `https://` URL。除 `localhost` 和 `127.0.0.1` 外，守护进程拒绝使用纯 `http://`。

## Serverless 托管（Vercel、Netlify、Workers）

Serverless 函数无法保持 WebSocket，但也用不着：在 FaaS 模式下，hub 运行在你的函数里，状态存在 Postgres 中，电脑通过 HTTP 流式传输连接。按你的平台阅读对应的页面：

- [Vercel 上的 Next.js](/docs/zh-cn/deploy/vercel/)：在 `app/api/uncage/[...path]/route.ts` 中使用 `toNextHandlers(getHub, { waitUntil: after })`。
- [Cloudflare Workers](/docs/zh-cn/deploy/cloudflare-workers/)：`fetchOnce` 在 Hyperdrive 连接池上为每个请求创建一个 hub。
- [其他 Fetch 平台](/docs/zh-cn/deploy/other-fetch-platforms/)：`hub.fetch(req, { clientIp, waitUntil })`。

网站在 Serverless 平台上，但还是想用传统模式？把上面任意一种服务器作为独立服务，运行在同一个源下：见 [Node → 常见问题](/docs/zh-cn/deploy/node/#我的网站在-vercel-或-netlify-上还能用传统模式吗)。
