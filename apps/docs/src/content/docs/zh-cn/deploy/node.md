---
title: Node（传统模式）
description: 在长期运行的 Node.js 进程中部署 hub，零外部依赖（PGlite + WebSocket），放在反向代理之后。包含完整的服务器代码、环境变量、部署步骤、验证清单和常见问题。
---

传统模式就是把 hub 放进一个持续运行的 Node.js 进程里：虚拟机、容器、Railway、Fly.io、Render 或你自己的服务器。它**不需要任何外部服务**：hub 把数据存在一个嵌入式 Postgres（PGlite）目录里，用户的电脑和它保持一条 WebSocket。不确定是不是该用这种模式？见[选择部署模式](/docs/zh-cn/start/choose-deployment-mode/)。

## 前提条件

- Node.js **22.18 或更高版本**：可以直接运行下面的 `.ts` 服务器，无需构建（更早的版本需要 `--experimental-strip-types`，或者先用 `tsc` 编译）。
- 一台能让进程持续运行、并为 hub 的数据目录（`.uncage-hub`）提供**持久磁盘**的主机。没有持久磁盘的话，每次重启都会忘掉已配对的电脑，用户必须重新运行 `uncage setup`。
- 前面有一个代理或负载均衡，转发 `/api/uncage/agent` 上的 **WebSocket 升级**（大多数托管平台默认支持），并提供 `https://`。
- 你的应用的登录状态，可以从 Fetch `Request` 中读取（一个会话 cookie）。

```sh
npm i @uncage/hub express
```

## 代码

两个文件。`auth.ts` 代表你的登录逻辑，请替换它的函数体。

```ts title="auth.ts"
import type { HubUser } from '@uncage/hub';

/** Your sign-in: the user a request belongs to, or null. */
export async function getSessionUser(req: Request): Promise<HubUser | null> {
  const cookie = req.headers.get('cookie') ?? '';
  // Look the session cookie up in your session store here.
  return cookie.includes('session=') ? { id: 'user-123', name: 'Ada' } : null;
}
```

```ts title="server.ts"
import { createServer } from 'node:http';
import { createHub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import express from 'express';
import { getSessionUser } from './auth.ts';

const port = Number(process.env.PORT ?? 3000);

// Embedded Postgres in a folder: one process per folder, kept across restarts.
const store = await pgliteHubStore({ dataDir: process.env.UNCAGE_DATA_DIR ?? './.uncage-hub' });
const hub = await createHub({
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  getUser: getSessionUser,
  store,
  sessionStorage: 'site', // keep a copy of every conversation on your site
});

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY)); // proxies in front: req.ip is the client
app.use(toNodeHandler(hub)); // first, before express.json() or compression()
app.use(express.json());
app.get('/', (_req, res) => {
  res.send('Your website');
});

const server = createServer(app);
attachWebSocket(hub, server); // computers connect to ws(s)://<host>/api/uncage/agent
server.listen(port, () => console.log(`ready on http://localhost:${port}`));

// On deploy or restart: stop taking requests, let running site tools finish, then close the store.
process.once('SIGTERM', () => {
  server.close();
  void hub
    .close()
    .then(() => store.close())
    .finally(() => process.exit(0));
});
```

各部分的作用：

- `toNodeHandler(hub)` 处理 `/api/uncage` 下的所有请求（浏览器 API、设备登录、`install.sh` 和 `install.ps1`，以及 HTTP 流式传输），其他路径交给 `next()`。它会把 `req.ip` 交给 hub，用于按 IP 限流。
- `attachWebSocket(hub, server)` 在同一个 HTTP 服务器上接受电脑的 WebSocket，并每分钟运行一次 hub 的维护任务（按保留期清理）。有了它，hub 会同时提供两种传输方式：守护进程使用 WebSocket，如果 WebSocket 连续失败（例如代理拦截了升级请求），会自动退回到 HTTP 流式传输。
- `hub.close()` 从不关闭你的 `store`：请在 hub 之后关闭它。

不用 Express，而是用 Fastify、Hono 或 Next.js 自定义服务器？[挂载 hub](/docs/zh-cn/guides/mount-the-hub/) 为每一种都提供了完整的服务器代码。只用 Next.js 的话：[Connected 模式快速上手](/docs/zh-cn/start/quickstart-connected/)会把这套配置搭进一个 Next.js 应用。

## 环境变量

| 变量 | 是否必填 | 含义 |
| --- | --- | --- |
| `PUBLIC_URL` | 生产环境必填 | 用户打开的确切源，例如 `https://app.example.com`。它会写进安装和 setup 命令，所以必须是 `https://`（只有 `localhost` 可以用普通的 `http://`）。 |
| `PORT` | 否 | 监听的端口（默认 `3000`）。 |
| `UNCAGE_DATA_DIR` | 否 | hub 的 PGlite 目录（默认 `./.uncage-hub`）。放在持久磁盘上，并加入 `.gitignore`。 |
| `TRUST_PROXY` | 在代理之后时 | 应用前面的代理层数，用于 `app.set('trust proxy', …)`。不设置的话，所有用户共用一个限流桶（见常见问题）。 |

这些变量名是本页自己定的；hub 本身不读取任何环境变量。

## 部署

1. **构建并启动**：`node server.ts`（Node 22.18+）。以容器为例：

   ```dockerfile title="Dockerfile"
   # Node 22.18 or newer runs server.ts directly (type stripping); node:22 is the latest 22.x.
   FROM node:22-slim
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --omit=dev
   COPY . .
   ENV UNCAGE_DATA_DIR=/data/uncage-hub
   VOLUME /data
   EXPOSE 3000
   CMD ["node", "server.ts"]
   ```

2. **给数据目录挂一个持久卷**（上例中的 `/data`）。Railway、Fly.io 和 Render 称之为 volume 或 disk。
3. **设置 `PUBLIC_URL`** 为你的 `https://` 源；如果前面有代理或负载均衡（在托管平台上几乎总是有），再设置 `TRUST_PROXY=1`。
4. **检查前面的代理**：
   - 转发 `/api/uncage/agent` 上的 WebSocket 升级，空闲超时大于 30 s（hub 每 10 s 发一次 ping）；
   - 不缓冲 `text/event-stream` 响应（浏览器事件）和 `application/x-ndjson` 响应（守护进程的流）；
   - 保留原始的 `Host` 请求头。

   以 nginx 为例：

   ```nginx title="nginx.conf (excerpt)"
   location / {
     proxy_pass http://127.0.0.1:3000;
     proxy_http_version 1.1;
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_buffering off;
     proxy_read_timeout 300s;
   }
   ```

5. **每个数据目录只运行一个进程。** PGlite 会锁住它的目录。需要多个进程时，见[多节点](/docs/zh-cn/guides/multi-node/)。

## 验证

把 `https://your.site` 换成你的 `PUBLIC_URL`。

- [ ] `curl -s https://your.site/api/uncage/install.sh | head -2` 输出 `#!/usr/bin/env bash` 和 `# Uncage installer…`。
- [ ] `curl -s https://your.site/api/uncage/agent/info` 列出**两种**传输方式，`ws` 在前：

  ```json
  {"protocol":2,"minAgentVersion":"0.3.0","transports":[{"kind":"ws","url":"wss://your.site/api/uncage/agent"},{"kind":"http","url":"https://your.site/api/uncage/agent"}]}
  ```

  只有 `http`？说明这个进程里没有运行 `attachWebSocket`。
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://your.site/api/uncage/health` 输出 `401`（未登录）。登录后，浏览器会收到 `{"ok":true,…}`。
- [ ] 在一台电脑上运行页面显示的命令（或 `uncage setup https://your.site`），在 `/device` 上批准验证码，页面显示这台电脑**在线**。
- [ ] 重启服务器：电脑在约 30 s 内重新上线，不需要重新运行 `uncage setup`（数据目录保留了下来）。

## 常见问题

### 我的网站在 Vercel 或 Netlify 上，还能用传统模式吗？

可以，作为一个单独的服务。把这个服务器跑在支持 WebSocket 的主机上，再在边缘层（负载均衡、Cloudflare，或者放在两者前面的 nginx）把 `https://your.site/api/uncage/*` **连同 WebSocket 升级**一起路由过去，让它和你的网站**同源**：浏览器 API 依赖你网站的 cookie 和同源校验。Vercel 的 rewrites 不代理 WebSocket（这时守护进程会退回到 HTTP 流式传输，能用，但失去了即时送达）。在 `getUser` 中，不借助框架的辅助函数来校验你网站的会话 cookie（例如校验认证库签发的 JWT 签名）。`/device` 审批页需要调用 `hub.approveDevice`，而它在这个进程里：要么也由这个进程提供 `/device`，要么暴露一个经过认证、带 CSRF 防护的小端点给页面调用。通常更简单的做法是：直接使用 [Vercel 上的 FaaS 模式](/docs/zh-cn/deploy/vercel/)。

### 很多用户同时遇到 `uncage setup` 以 `429 rate_limited` 失败

在代理之后，除非另行配置，hub 看到的是代理的地址，于是所有用户共用一个每分钟 20 个设备码的限流桶。设置 `TRUST_PROXY`（见上文），或者用代理的客户端 IP 请求头传入 `rateLimits: { clientIp: (req) => req.headers.get('x-real-ip') ?? undefined }`。详见[反向代理或负载均衡之后](/docs/zh-cn/guides/mount-the-hub/#反向代理或负载均衡之后)。

### 代理拦截了 WebSocket，还能用吗？

能。WebSocket 连续失败三次后，守护进程会切换到 HTTP 流式传输（由同一个 `toNodeHandler` 提供），之后每 30 分钟重试一次 WebSocket。不过还是建议修好代理：WebSocket 能即时送达命令，成本也更低。

### 可以用 Postgres 代替 PGlite 吗？

可以：`store: await postgresHubStore({ connectionString: process.env.DATABASE_URL! })`（需要安装 `pg`）。想要托管备份或多个节点时就这么做。带连接池的连接串（PgBouncer、Neon 的 `-pooler`）也能用：迁移使用事务级锁。

### 需要 Redis 吗？

单个进程不需要。多个节点时，按[多节点](/docs/zh-cn/guides/multi-node/)里的做法加上 `redisCluster`（或 `postgresCluster`）。

### 一次部署重启了服务器，正在进行的工作怎么样了？

电脑会自动重连（退避间隔从 1 s 增加到 30 s）。任务在用户电脑上继续运行，重连后事件会补齐。进程停止时仍在运行的网站工具 handler 会以“Site tool "<name>" timed out on the website. Please try again.”失败：`hub.close()` 会先给正在运行的 handler 留出 `toolDrainMs`（5 s）的时间收尾。

### 旧版守护进程（0.2）连不上

hub 会告诉它们需要升级（`upgrade_required`），0.2 的守护进程会自行升级（`npm i -g @uncage/cli@latest`）。见[故障排查](/docs/zh-cn/reference/troubleshooting/#需要更新守护进程--426-upgrade_required)。
