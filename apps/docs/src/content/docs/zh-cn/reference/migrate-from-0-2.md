---
title: 从 0.2 迁移
description: Uncage 0.3 的全部破坏性变更及迁移前后的代码：@uncage/hub 改为 Web 标准实现，Node 专用部分移到 @uncage/hub/node，store 变为必填，hub.fetch 和 attachWebSocket 取代 hub.handler 和 hub.attach，守护进程必须是 0.3 或更新版本；以及新增的选项和 HubStore 方法。
---

Uncage 0.3 让 hub 不再依赖特定平台：同一个 hub 既能运行在 Node 进程中（传统模式），也能运行在 Serverless 和 Fetch 平台上（FaaS 模式），见[选择部署模式](/docs/zh-cn/start/choose-deployment-mode/)。0.3 没有为 0.2 提供兼容层，所以 0.2 的网站需要做下面这些小改动。请把你依赖的所有 `@uncage/*` 包一起升级到 0.3（它们共用一个版本号；如果用到了 `@uncage/server`、`@uncage/core`、`@uncage/agent` 和各个运行时，也一并升级；`@uncage/cli` 由用户自己升级）。

```sh
npm i @uncage/hub@^0.3 @uncage/react-ui@^0.3 @uncage/react@^0.3 @uncage/client@^0.3 @uncage/protocol@^0.3 # every @uncage/* package you use, together
```

## 传统模式服务器：迁移前后对比

大多数 0.2 网站需要的正是这处改动：

```ts nocheck
// 0.2
import { createHub, toNodeHandler } from '@uncage/hub';

const hub = await createHub({ publicUrl, getUser });
app.use(toNodeHandler(hub));
const server = createServer(app);
hub.attach(server);
```

```ts title="server.ts"
// 0.3
import { createServer } from 'node:http';
import { createHub, type HubUser } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import express from 'express';

declare function getUser(req: Request): Promise<HubUser | null>;

const store = await pgliteHubStore({ dataDir: './.uncage-hub' }); // the folder 0.2 used by default
const hub = await createHub({ publicUrl: 'https://app.example.com', getUser, store });
const app = express();
app.use(toNodeHandler(hub));
const server = createServer(app);
attachWebSocket(hub, server);
server.listen(3000);
```

保留 `dataDir: './.uncage-hub'`（或你原来用的目录），已配对的电脑、会话和副本都会保留下来：store 会在启动时执行新的迁移。

## 破坏性变更

### `@uncage/hub` 根入口改为 Web 标准实现，Node 专用部分移到 `@uncage/hub/node`

根入口只使用 Web API，因此可以为 Workers、Vercel 和其他 Fetch 平台打包。只能在 Node 上运行的部分移走了：

| 0.2（`@uncage/hub`） | 0.3 |
| --- | --- |
| `toNodeHandler(hub)` | **`@uncage/hub/node`** 中的 `toNodeHandler(hub)` |
| `hub.attach(server, { path? })` | **`@uncage/hub/node`** 中的 `attachWebSocket(hub, server, { path? })`。返回一个 `detach()` 函数；`hub.close()` 也会解除挂接。一个 hub 同一时间只能挂接一个服务器。 |
| `pgliteHubStore({ dataDir })` | **`@uncage/hub/node`** 中的 `pgliteHubStore({ dataDir })` |

其他所有内容（`createHub`、`defineTool`、`postgresHubStore`、`redisCluster`、类型）仍在 `@uncage/hub` 中。

### `createHub` 必须传入 `store`

0.2 在没有 `store` 时会自动创建 `pgliteHubStore({ dataDir: './.uncage-hub' })`。0.3 会抛出 `createHub: store is required`。请传入 `pgliteHubStore(…)`（单个 Node 进程）或 `postgresHubStore(…)`（多节点、FaaS）。

### `hub.handler` → `hub.fetch`

`hub.handler(req, info?)` 改名为 `hub.fetch(req, info?)`。`info` 新增了 `waitUntil(promise)`，这是平台提供的钩子，用于可能比响应活得更久的工作（Workers 的 `ctx.waitUntil`、Next 的 `after`）。

### `hub.close()` 从不关闭你的 store

0.2 会关闭由 hub 自己创建的 store。0.3 从不关闭 `store`（它始终归你管理）：请在 `await hub.close()` 之后调用 `await store.close()`。cluster 仍然只有在由 hub 创建时（没有传 `cluster` 选项）才会被关闭。`hub.close()` 现在还会给正在运行的网站工具 handler 留出 `toolDrainMs`（5 s）来收尾。

### 守护进程必须是 0.3 或更新版本

Connected 协议现在是第 2 版，`minAgentVersion` 默认为 `0.3.0`。

- **传统模式：** 通过 WebSocket 连接的 0.2 守护进程会收到 `upgrade_required`；0.2 守护进程会自行升级（`npm i -g @uncage/cli@latest`）并重新连接。
- **FaaS 模式：** 0.2 守护进程只会用 WebSocket，而 FaaS 模式的 hub 不提供 WebSocket。它会收到 `426 upgrade_required`，hub 把这台电脑标记为版本过旧，网站显示**需要更新守护进程**以及要运行的命令（`npm i -g @uncage/cli@latest`，然后 `uncage setup <url>`）。`<AgentChat>` 会自动显示这些内容（`<AgentOutdatedNotice>`、`MachineInfo.agentOutdated`）。

hub 提供的 `install.sh` 默认安装 `@uncage/cli@^0.3`。

### `@uncage/server/wire` 不再导出 Node handler

Fetch → Node 适配器移到了独立的子路径：`import { toNodeHandler } from '@uncage/server/node-handler'`。只有自己写过 Node 适配器才会用到它；Local 模式的代理（`@uncage/server/proxy`）没有变化。

### 从 `@uncage/core/errors` 导入 `UncageError`

`@uncage/core/errors` 是一个新的子路径，只包含错误相关的辅助工具（`UncageError`），不带 `@uncage/core` 的其他部分（那些会引入 Node API）。在 Web 标准 bundle 中运行的代码（Worker，或与 Worker 共用的网站工具）应该从这里导入。`@uncage/core` 也仍然导出它。

### `fetchOnce` 和 `toNextHandlers`（新增）

不是破坏性变更，而是根入口中新增的挂载辅助函数：`toNextHandlers(hub | promise | getter, { clientIp?, waitUntil? })` 为 Next.js route handler 返回 `{ GET, POST, PATCH, DELETE }`；`fetchOnce(create, req, { clientIp?, waitUntil? })` 在无法共享 socket 的地方（Workers）为每个请求创建一个 hub。`create(defer)` 返回一个 hub 或 `{ hub, close }`。见 [Vercel 上的 Next.js](/docs/zh-cn/deploy/vercel/) 和 [Cloudflare Workers](/docs/zh-cn/deploy/cloudflare-workers/)。

### 限流在 store 中计数

设备码、验证码失败次数以及新增的机器令牌失败次数，现在都在 store 中计数，由所有节点和函数实例共享（0.2 是每个节点分别计数）。不需要做任何改动，除非你自己实现了 `HubStore`（见下文）。在 FaaS 模式下，请把客户端 IP 交给 hub：没有它，所有调用方共用一个限流桶（hub 会记录一次警告）。在 Vercel 上 `toNextHandlers` 会处理；`fetchOnce` 接受 `clientIp`。

### `HubStore` 新增了方法

只有自己写过 `HubStore` 才需要关心（内置的 `pgliteHubStore`、`postgresHubStore` 和 `sqlHubStore` 都已实现）。新增：每台电脑的 **link**（`openLink`、`pollLink`、`updateLink`、`closeLink`）、持久化的 **outbox**（`enqueueOutbox`）、用于去重的上行 **inbox**（`claimInbox`、`completeInbox`、`releaseInbox`）、**工具调用状态**（`claimToolCall`、`finishToolCall`、`getToolCall`、`listStaleToolCalls`、`pruneToolCallResults`）、**共享计数器**（`hitRateLimit`、`releaseRateLimit`）、**维护任务租约**（`tryLease`）、保留期清理（`pruneTransport`），以及 `markMachineOutdated`、`recordDevicePoll`。变更：`finishToolCall(id, finish)` 现在还要传入结果（`ToolCallFinish & { result }`），并返回 `boolean`（这次完成是否胜出；以前返回 `void`）。`MachineRecord` 新增了可选的 `outdatedAt`。SQL store 会在启动时执行新的迁移；在 Postgres 上，迁移使用事务级 advisory lock，所以在 PgBouncer / Neon `-pooler` 之后也能工作。

### `hub.maintain()`（新增）

`hub.maintain()` 立即运行维护任务（除非另一个实例持有租约），返回 `{ ran, pruned, interruptedToolCalls }`。你很少需要直接调用它：`attachWebSocket` 会定时运行它，在 FaaS 模式下则由请求或 `GET <basePath>/maintenance` 触发。Workers 的 Cron Trigger 可以在 `scheduled` 中调用它。

### `ClusterAdapter.refreshPresence`（可选）

自定义的 cluster 适配器可以实现 `refreshPresence(machineId, nodeId, ttlSec): Promise<boolean>`（仅当在线状态不存在或已经属于自己时才原子地设置）。没有实现的话，hub 会退回到先检查再设置。`memoryCluster`、`redisCluster` 和新增的 `postgresCluster` 都实现了它。

### 传输格式和 API 结构

- `MachineInfo` 新增两个字段：`agentOutdated`（boolean）和 `transport`（`'ws' | 'http' | null`）。
- `GET /machines/install` 在 `windows` 中返回 Windows 命令（`irm https://<site>/api/uncage/install.ps1 | iex`），不再是 `null`。hub 也会提供 `install.ps1`。
- 设备令牌的响应会列出 hub 提供的传输方式；`GET <basePath>/agent/info`（公开）也会列出。
- 自己实现守护进程协议客户端的：见 [HTTP API → 守护进程的传输方式](/docs/zh-cn/reference/http-api/#守护进程的传输方式http-流式传输)。

## 新增选项

全部可选。完整说明：[挂载 hub → 选项](/docs/zh-cn/guides/mount-the-hub/#createhub-选项)。

| 选项 | 默认值 | 作用 |
| --- | --- | --- |
| `transports` | 使用 `attachWebSocket` 时为 `['ws', 'http']`，否则为 `['http']` | 提供给守护进程的传输方式。 |
| `stream.maxDurationMs` | `250000` | 超过这个时长，hub 会结束守护进程的流**和浏览器的事件流**；客户端立即重连，没有空档。请保持在平台的请求时间上限以下。 |
| `polling` | `{ activeMs: 300, idleMs: 2000, activeWindowMs: 30000 }` | 守护进程的 HTTP 流轮询其 outbox 的频率。 |
| `rateLimits.agentAuthFailuresPerMinute` | `60` | 每个客户端 IP 每分钟向 `/agent/*` 发出的、缺少机器令牌或令牌错误的请求数上限。 |
| `maintenance` | `{ intervalMs: 60000 }` | 按保留期清理，并把已挂掉实例上的工具调用标为失败；所有实例加起来每个间隔最多运行一次。`secret` 启用 `GET\|POST <basePath>/maintenance`（Vercel Cron）；`onRun` 用于加入你自己的清理逻辑。 |
| `bodyTimeoutMs` | `30000` | 请求体没有按时完整收到时，以 `400` 拒绝。 |
| `toolDrainMs` | `5000` | `hub.close()` 给正在运行的网站工具 handler 留出的收尾时间。 |
| `installScript` | 无 | 为 `install.sh` / `install.ps1` 追加的固定步骤。 |
| `postgresCluster({ pool \| connectionString })` | | 基于 Postgres 的 `ClusterAdapter`：多节点或 FaaS 都不再需要 Redis。 |

维护任务的保留期：从未得到应答的运行清单保留 1 h，其他保留 7 天；hub 保存的附件副本保留 `attachmentRetentionDays`（30）天；去重记录保留 24 h；已存储的工具结果在调用结束后保留 24 h；outbox 条目到期即删除；设备码在过期一小时后删除。在传统模式下，`attachWebSocket` 每分钟运行一次；在 FaaS 模式下由请求触发。

## 需要了解的行为变化

- **网站工具调用能挺过连接断开**：调用和结果都会存储，所以守护进程重试时拿到的是已存储的结果，而不是再执行一次（恰好一次；在 FaaS 平台上的前提是把平台的 `waitUntil` 交给 hub，见 [Workers → 常见问题](/docs/zh-cn/deploy/cloudflare-workers/#在-workers-上网站工具会恰好执行一次吗)）。如果运行 handler 的实例挂掉，这次调用会以“Site tool "<name>" timed out on the website. Please try again.”失败，并且不会重试（最多执行一次）。`ctx.signal` 现在会在超时、运行结束或 hub 关闭时中止，但电脑的连接断开时不再中止。详见[定义网站工具](/docs/zh-cn/guides/define-tools/#连接断开或实例停止时)。
- **浏览器的事件流会轮换**，每 `stream.maxDurationMs` 一次（发送一个 `event: reconnect` 帧）。`@uncage/client` 会自动带着 `Last-Event-ID` 续接；自定义的 SSE 客户端收到它时应当重连。
- **WebSocket 连不上时（连续失败三次），电脑可以改用 HTTP 流式传输连接**，之后每 30 分钟重试一次 WebSocket。
- **`<ConnectMachine>` 只显示一条命令**：网站的安装脚本，放在“macOS / Linux”和“Windows”两个标签页里，默认打开访客所用系统的那一页（现在会显示 `install.windows`）；`uncage setup <url>` 放在“已经装好 CLI？”下面。原来带编号的两步列表（`ol.uc-connect-steps`、`.uc-connect-num`）已经移除，如有 CSS 针对它们，请一并更新。

## 检查清单

- [ ] 所有 `@uncage/*` 包都升级到 0.3。
- [ ] `toNodeHandler`、`attachWebSocket`、`pgliteHubStore` 从 `@uncage/hub/node` 导入；不再有 `hub.attach` 和 `hub.handler`。
- [ ] 把 `store` 传给了 `createHub`，并在 `hub.close()` 之后关闭它。
- [ ] `pnpm build` / `tsc` 通过。
- [ ] `curl -s https://your.site/api/uncage/agent/info` 显示 `"protocol":2`。
- [ ] 使用 0.2 守护进程的用户：守护进程会自行升级（传统模式），或者按照**需要更新守护进程**的提示操作（FaaS 模式）。
