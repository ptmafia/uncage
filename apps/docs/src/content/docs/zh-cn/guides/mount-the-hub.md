---
title: 挂载 hub
description: 在 Next.js 自定义服务器、Express、Fastify 或 Hono 中挂载 @uncage/hub 的完整服务器示例，外加 createHub 的全部选项、代理配置，以及网站部署在 Vercel 上时如何托管 hub。
---

hub 需要从你的服务器拿到两样东西：

1. 基础路径（默认 `/api/uncage`）下的 **HTTP 请求**：浏览器 API、设备端点和 `install.sh`。使用 `hub.handler(request)`（Fetch API）或 `toNodeHandler(hub)`（Node 的 `req, res, next`）。
2. `<basePath>/agent` 上的 **WebSocket 升级**，已连接的电脑从这里接入。`hub.attach(httpServer)` 会在你的 Node HTTP 服务器上注册它们。

所以 hub 运行在一个长期存活的 Node 进程里（Node.js 22 或更高版本）。下面每个示例都是一个完整的服务器文件。它们都从 `./auth` 导入同一个 `getSessionUser`，代表你应用的登录体系（见[认证与设备授权](/docs/zh-cn/guides/auth-and-device-approval/)）：

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

使用 `@hono/node-server` 时，把 Fetch `Request` 直接交给 `hub.handler`，并传入客户端地址用于限流：

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

Next.js 的 route handler 无法接受 WebSocket 升级，所以要在你自己的 Node 服务器里运行 Next.js，并把 hub 放在它旁边。[Connected 模式快速上手](/docs/zh-cn/start/quickstart-connected/)和 `connected-demo` 示例都是这样做的：

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

对已登录用户，`/health` 返回 `{"ok":true,"protocol":"1.0","version":"…"}`，否则返回 `401 unauthorized`。

## `createHub` 选项

只有 `publicUrl` 和 `getUser` 是必填的。

| 选项 | 默认值 | 作用 |
| --- | --- | --- |
| `publicUrl` | （必填） | 你网站的公开源，例如 `https://app.example.com`。用于安装和 setup 命令、`/device` 链接，以及 CSRF 源校验。 |
| `getUser(req)` | （必填） | 你的认证：已登录的浏览器请求返回 `{ id, name? }`，否则返回 `null`。 |
| `basePath` | `/api/uncage` | hub 挂载的位置。如果修改了它，要把同样的路径作为 `baseUrl` 传给 `UncageProvider`。 |
| `tools` | `[]` | 用 `defineTool` 定义的网站工具。[指南](/docs/zh-cn/guides/define-tools/) |
| `skills` | `[]` | `SkillSpec[]`。[指南](/docs/zh-cn/guides/write-skills/) |
| `selectManifest(ctx)` | 全部工具和技能 | 按运行挑选工具和技能。[指南](/docs/zh-cn/guides/select-manifest/) |
| `sessionStorage` | `'machine'` | `'site'` 会保存每段对话的副本。[指南](/docs/zh-cn/guides/site-storage/) |
| `attachmentRetentionDays` | `30` | hub 保留经网站发送的附件副本的天数（每小时清理一次；`Infinity` 表示永久保留）。被吊销电脑的附件会立即删除。[详情](/docs/zh-cn/guides/site-storage/#附件) |
| `store` | `pgliteHubStore({ dataDir: './.uncage-hub' })` | `HubStore`。多节点时使用 `postgresHubStore`。 |
| `cluster` | `memoryCluster()` | `ClusterAdapter`。多节点时使用 `redisCluster`。[指南](/docs/zh-cn/guides/multi-node/) |
| `site` | 取自 `publicUrl` 主机名的 id 和名称 | `{ id?, name? }`，配对时展示给电脑。请保持 `id` 稳定。 |
| `verificationPath` | `/device` | 你的审批页。[指南](/docs/zh-cn/guides/auth-and-device-approval/) |
| `minAgentVersion` | 当前 hub 的版本 | 更旧的守护进程会收到升级提示（`upgrade_required`）；用户运行 `npm i -g @uncage/cli@latest` 后重新连接。 |
| `cliVersionRange` | hub 的 `^<major.minor>` | `install.sh` 安装哪个版本的 `@uncage/cli`（`^0.2`、`~0.2.1`、`0.2.0` 或 `latest`）。 |
| `heartbeat` | `{ pingIntervalMs: 10000, missedPings: 2 }` | 失去响应的电脑约 30 秒后显示为离线。 |
| `sseHeartbeatMs` | `15000` | 浏览器事件流上的保活注释间隔。 |
| `commandTimeoutMs` | `30000` | 浏览器请求等待电脑响应的时长。 |
| `toolTimeoutMs` | `120000` | 工具 handler 超过这个时长仍在运行，就以 `tool_failed` 失败。 |
| `maxConcurrentToolCalls` | `8` | 一台电脑同时可以进行的工具调用数。 |
| `rateLimits` | 见下文 | 设备登录的防滥用限制。 |

`rateLimits`：`deviceCodesPerMinute`（每个客户端 IP 20 次）、`userCodeFailures`（每个用户猜错验证码的次数上限，10 次）和 `userCodeWindowMs`（统计窗口，10 分钟），以及 `clientIp(req)` 和 `trustForwardedFor`（见[反向代理或负载均衡之后](#反向代理或负载均衡之后)）。超出限制时返回 `429 rate_limited`。限制按节点分别计数。

返回的 `Hub` 有 `basePath`、`handler(req, info?)`、`attach(server, { path? })`、`approveDevice`、`denyDevice`、`lookupDevice`、`revokeMachine` 和 `close()`。只有存储和集群是 hub 自己创建的时候，`close()` 才会关闭它们；你自己创建的，请在它之后自行关闭。

## 反向代理或负载均衡之后

:::caution[上线前设置客户端 IP]
`POST <basePath>/device/code`（每次 `uncage setup` 都会调用）的限制是**每个客户端 IP 每分钟 20 次**。在反向代理、负载均衡或 CDN 后面，除非你另行告知，hub 看到的是代理的地址，而不是用户的地址。这时**所有用户共用一个限流桶**：全站一分钟内从第 21 次 setup 起，`uncage setup` 都会以 `429 rate_limited` 失败。

用下面任一种方式解决：

- Express：`app.set('trust proxy', 1)`（数字是应用前面的代理层数）。`toNodeHandler` 随后会传入 `req.ip`。
- 任何服务器：`rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined }`（换成你所用平台的客户端 IP 请求头）。
- `rateLimits: { trustForwardedFor: true }`，仅当你的代理会把客户端地址追加到 `X-Forwarded-For` 时使用（hub 取最右边的一项）。
:::

- **转发 `<basePath>/agent` 上的 WebSocket 升级**（nginx：`proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`），并允许长连接（hub 每 10 秒 ping 一次）。
- **保留原始的 `Host`**（nginx：`proxy_set_header Host $host;`）。hub 会拿请求的 `Origin` 和 `publicUrl` 以及 `Host` 比较，以拒绝跨站 POST。
- **不要缓冲 `<basePath>/sessions/*/events` 上的 SSE**（nginx：`proxy_buffering off;`）。
- **限流用的客户端 IP。** Express：`app.set('trust proxy', 1)`，`toNodeHandler` 会使用 `req.ip`。Fetch 风格的服务器：传入 `rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined }`（或你所用平台的请求头）；如果你的代理会把客户端地址追加到 `X-Forwarded-For`，则用 `trustForwardedFor: true`。这些都不设置时，每个客户端都按代理的地址（或一个 `shared` 桶）计数，限制就作用于所有用户的总和。
- **TLS。** 在哪里终止都可以，但 `publicUrl` 必须是用户打开的 `https://` URL。除 `localhost` 和 `127.0.0.1` 外，守护进程拒绝使用纯 `http://`。

## Serverless 托管（Vercel、Netlify）

Serverless 函数无法保持 WebSocket，所以无法托管 hub。网站留在原处，把 hub 作为一个小型 Node 服务（上面任意一种服务器）运行在支持 WebSocket 的平台上（Fly.io、Railway、Render、容器、虚拟机）。然后让它和你的网站处于**同一个源**，因为浏览器 API 依赖你网站的 cookie 和同源校验：

- 在你的边缘层（负载均衡、Cloudflare，或挡在两者前面的 nginx），把 `https://your.site/api/uncage/*` **连同 WebSocket 升级**一起路由到 hub 服务。Vercel 的 rewrites 不会代理 WebSocket，所以要在 Vercel 前面做，而不是在 Vercel 内部。
- 把 `publicUrl` 设为 `https://your.site`。
- 在 `getUser` 里，不借助框架的辅助函数校验你网站的会话 cookie：例如校验你的认证库签发的 JWT，或在共享的会话数据库里查找会话 id。
- 审批页仍留在网站上；它需要 `hub.approveDevice`，而这只存在于 hub 进程里。可以让 hub 服务也提供 `/device`（把它路由过去），或者在 hub 服务上开放一个带认证和 CSRF 防护的小端点，供你的页面调用。
