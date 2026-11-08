---
title: 多节点（Redis + Postgres）
description: 用 postgresHubStore 和 redisCluster 在负载均衡后面以两个或更多节点运行 hub：哪些内容在节点间传递、负载均衡的设置，以及如何在本地试用。
---

对很多部署来说，一个 hub 节点就够了。需要更多时（可用性、滚动部署、更多连接），在负载均衡后面的多个节点上运行同一个 hub。不需要粘性会话。

## 有什么变化

一台电脑的 WebSocket 落在某一个节点（A）上。浏览器请求可能落在任意节点（B）上。两个共享组件让这一切成立：

| | 单节点（默认） | 多节点 |
| --- | --- | --- |
| `store`（`HubStore`） | `pgliteHubStore({ dataDir })`：内嵌 Postgres，每个数据目录一个进程 | `postgresHubStore({ connectionString })` 或 `({ pool })`。需要 `pg`。 |
| `cluster`（`ClusterAdapter`） | `memoryCluster()`：进程内 | `redisCluster({ url })` 或 `({ client })`。需要 `ioredis`。 |

```mermaid
flowchart LR
  B["Browser"] --> LB["Load balancer"]
  M["User's computer"] -- "WSS" --> LB
  LB --> N1["Hub node A<br/>holds the computer's socket"]
  LB --> N2["Hub node B<br/>serves the browser request"]
  N1 <-- "presence, commands,<br/>results, events" --> R[("Redis")]
  N2 <--> R
  N1 --> P[("Postgres")]
  N2 --> P
```

- B 查出哪个节点持有这台电脑（Redis 里的在线信息），把命令发布到 A 的频道；A 把它转发给电脑，再把结果发布回来。
- 会话事件通过 Redis pub/sub 分发到每个节点，所以浏览器无论从哪个节点接收事件流都能看到。
- 网站工具调用在 A 上运行，也就是持有电脑连接的节点。
- 在 B 上做出的审批决定恰好送达电脑一次。电脑是唯一的裁决者：如果两个决定同时到达，后到的得到 `409`。

## 配置

```sh
npm i pg ioredis
```

```ts title="hub.ts"
import { createHub, postgresHubStore, redisCluster, type HubUser } from '@uncage/hub';

declare function getUser(req: Request): Promise<HubUser | null>;

const store = await postgresHubStore({ connectionString: process.env.DATABASE_URL! });
const cluster = redisCluster({ url: process.env.REDIS_URL! });

export const hub = await createHub({
  publicUrl: 'https://app.example.com', // the same on every node
  getUser,
  store,
  cluster,
  sessionStorage: 'site',
});

/** On shutdown: the hub closes only what it created, so close the store and cluster after it. */
export async function closeHub(): Promise<void> {
  await hub.close();
  await cluster.close();
  await store.close();
}
```

在服务器里的挂载方式和单节点完全相同（[挂载 hub](/docs/zh-cn/guides/mount-the-hub/)）。

- **迁移**在存储启动时运行。使用 Postgres 时，迁移在 advisory lock 下运行，所以多个节点可以同时启动。
- **每个节点的配置必须相同：** `publicUrl`、`basePath`、`site`、`tools`、`skills`、`selectManifest`、`sessionStorage`。工具调用在持有电脑 socket 的那个节点上运行，所以每个节点都需要全部工具。
- **多个部署共用一个 Redis**（比如预发布和生产环境）时，使用不同的 `keyPrefix`：`redisCluster({ url, keyPrefix: 'myapp-staging:' })`。默认是 `uncage:`。它同时作为在线信息键和 pub/sub 频道的前缀。

### 使用你自己的连接池或客户端

```ts title="own-clients.ts"
import { postgresHubStore, redisCluster } from '@uncage/hub';
import { Redis } from 'ioredis';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
pool.on('error', (err) => console.error('postgres pool error', err)); // required: see below
const redis = new Redis(process.env.REDIS_URL!);
redis.on('error', (err) => console.error('redis error', err));

export const store = await postgresHubStore({ pool });
export const cluster = redisCluster({ client: redis, keyPrefix: 'myapp:' });
```

空闲连接断开时（数据库重启或故障切换），node-postgres 会在连接池上触发 `'error'`。没有监听器时，进程会崩溃。hub 自己创建的连接池或客户端（`{ connectionString }`、`{ url }`）会带一个记录日志的监听器（`onError` 选项，默认 `console.error`）。**如果你传入自己的 `pool` 或 `client`，请自己挂上 `'error'` 监听器。**

## 负载均衡

- `<basePath>/agent` 上的 **WebSocket** 必须被转发（HTTP/1.1 `Upgrade`），空闲超时要大于 10 秒的心跳间隔。不需要粘性。
- `<basePath>/sessions/:id/events` 上的 **SSE** 不能被缓冲，空闲超时要大于 15 秒（SSE 心跳间隔）。
- 保留 **Host 请求头**，并传递**客户端 IP** 用于限流：见[反向代理或负载均衡之后](/docs/zh-cn/guides/mount-the-hub/#反向代理或负载均衡之后)。
- **排空：** 部署时，先停止向某个节点发送新请求，再 `close()` 它。它上面的电脑会以指数退避（从 1 秒开始，最多 30 秒）重连到其他节点；期间它们的运行在本地照常进行，重连后事件会补齐。

:::caution[负载均衡后面的客户端 IP]
`POST <basePath>/device/code` 的限制是**每个客户端 IP** 每分钟 20 次，按节点计数。在负载均衡后面，所有请求都来自负载均衡的地址，除非你设置了 `app.set('trust proxy', <hops>)`（Express，配合 `toNodeHandler`）、`rateLimits.clientIp(req)` 或 `rateLimits.trustForwardedFor: true`。三者都不设置时，每个节点上所有用户共用一个桶，同一分钟内只要有大约 20 个人连接，`uncage setup` 就会开始以 `429 rate_limited` 失败。
:::

## 需要知道的限制

- 限流（每个 IP 的设备码数、每个用户猜错验证码的次数）**按节点**计数，不共享。按 IP 的限制需要真实的客户端 IP（见上面的警告）。
- `pgliteHubStore` 不能在进程之间共享：它会锁住自己的数据目录。多节点必须使用 Postgres。

## 在本地试用

参考演示项目有一个双节点模式，前面是一个简单的轮询代理（不带粘性），所以电脑和浏览器通常会落在不同的节点上：

```sh
cd examples/connected-demo
docker compose up -d                # redis:7-alpine on 127.0.0.1:6380, postgres:16-alpine on 127.0.0.1:5433
pnpm build
HUB_NODES=2 REDIS_URL=redis://127.0.0.1:6380 \
  DATABASE_URL=postgres://uncage:uncage@127.0.0.1:5433/uncage pnpm multinode
# proxy on :3200, nodes on :3201 and :3202
docker compose down                 # when done
```

然后按[快速上手](/docs/zh-cn/start/quickstart-connected/#9-连接你的电脑用户一侧)的步骤，对 `http://localhost:3200` 连接一台电脑并运行一个任务。E2E 测试套件也会运行这个配置（在 `e2e/` 下执行 `UNCAGE_DOCKER_TESTS=1 pnpm exec playwright test --project=connected-multinode`），并检查两个节点都有响应。

hub 自己的测试会在一个进程里用 `ioredis-mock` 运行同样的双节点场景（`pnpm --filter @uncage/hub test`），设置 `UNCAGE_DOCKER_TESTS=1` 时还会对真实的 Redis 和 Postgres 容器运行。
