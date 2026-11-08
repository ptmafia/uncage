# Uncage 0.3 — 平台无关：FaaS 模式 + 传统模式 设计

> 2026-11-08 · 前置：0.2.0 已发布（Connected Mode，hub 依赖常驻 Node 进程 + WebSocket）；官网/帮助站在 Vercel（https://uncage-dev.vercel.app），demo 只能上 Railway。

## 1. 意图

用户原话："我做框架按说和部署环境无关才对啊。比如我还想部署 cf 中呢""作为框架你要有清晰的定位，任何平台都可以接入""就是支持 FaaS 模式和传统模式，帮助文档也要写的足够友好"。

**定位**：Uncage 是平台无关的框架。网站部署在哪里（常驻服务器、Vercel、Cloudflare Workers、Netlify、Deno、Bun……），都能用同一套 API 接入 Connected Mode。

**验收的画面**（用户确认）：`examples/connected-demo` 不需要任何额外常驻服务，部署到 Vercel 就能跑通完整链路；同时框架层面提供 Cloudflare Workers 的接入方式。部署由用户自己做，我方负责框架、示例和文档，并在本地用各平台的官方本地运行时验证。

## 2. 目标 / 非目标 / 反目标

**目标**
- 两种运行模式，一套 API：
  - **传统模式**（常驻进程）：现状，WebSocket + PGlite/Postgres，零外部依赖。
  - **FaaS 模式**（函数平台）：hub 以标准 `fetch(Request) → Response` 处理一切，无本地状态，连接随时可被平台切断也能无缝续上。
- 用户电脑上的 agent 自动适配网站支持的传输方式，用户无感（同一个 `uncage setup <site>`）。
- **允许破坏性更新**（用户：目前还没有用户）。版本 0.3.0（0.x 下 minor 即可破坏；不发 1.0，等 API 稳定后再说）。附一页简短的“从 0.2 迁移”。
- connected-demo 同一份代码可以按传统模式（Railway/Node）或 FaaS 模式（Vercel）部署。
- 新增 Cloudflare Workers 接入示例（Hono 或原生 Worker）。
- 帮助站：新增"选择部署模式"指南 + 各平台一步步接入页（Node / Next.js on Vercel / Cloudflare Workers / 其他 Fetch 平台），三语（en / zh-CN / ja），面向开发者和 coding agent 都友好。
- 官网 Coming soon 卡片 "Serverless-ready transport" 改为已支持（三语）。

**非目标**
- 不做第三方实时服务（Ably/Pusher）适配。
- 除 `postgresCluster` 外不新增 cluster 后端（Durable Objects 适配留到以后；接口要能容纳它）。
- 不改 Local Mode。
- 不做 Windows/Linux agent。

**反目标**（即使"能用"也算失败）
- FaaS 模式需要开发者理解传输细节、自己写重连或轮询代码。
- 为了 FaaS 让传统模式变复杂、变慢，或要求传统模式用户引入外部服务。
- 平台被切断连接时丢事件、重复执行工具、审批卡丢失或重复。
- 文档只讲 Vercel，或各平台页面只是代码堆砌、没有"为什么/选哪个"。
- 宣称支持某平台但没有在其本地运行时（`next start` 无自定义服务器 / `wrangler dev`）实际跑通过。

## 3. 已定决策

| 项 | 决策 | 来源 |
|---|---|---|
| 定位 | 平台无关；FaaS 模式 + 传统模式 | 用户 |
| 外部依赖 | 尽可能简单：FaaS 模式只需要一个 Postgres（`DATABASE_URL`），不强制 Redis | 用户（"尽可能简单"）+ 我方推荐 |
| 部署 | 用户自己部署；我方本地验证 | 用户 |
| 文档 | 足够友好，三语 | 用户 |
| demo 在 Vercel 跑通 | 必须 | 用户 |

## 4. 平台事实（2026-11 调研）

- **Vercel Functions**：Node 运行时默认/上限 300s（Hobby），Pro 可到 800s，Node/Python 在 Pro 上 beta 可到 30 分钟；超时返回 504。2026-06 起 Functions 支持 WebSocket（公测，连接同样受时长限制，实测约 5 分钟被断开）。实例间不共享内存。
- **Cloudflare Workers**：HTTP 触发的 Worker 无总时长上限（客户端连着就行），限制的是 CPU 时间（付费默认 30s，可到 5 分钟；等待 I/O 不计）。Worker 内可直接接受 WebSocket（`WebSocketPair`），跨实例协调需要 Durable Objects 或外部服务。
- 结论：两类平台共同点是 **"连接会被切断、实例无状态"**。传输必须可续传，状态与跨实例消息必须在外部存储。

## 5. 设计（我方判断，实现者可调整细节但不改方向）

### 5.1 核心：hub 只依赖 Web 标准
- hub 核心只用 Web 标准 API（`Request`/`Response`/`ReadableStream`/`crypto.getRandomValues`/`crypto.subtle`/`TextEncoder`），去掉核心路径上的 `node:crypto`、`node:path`、`node:http`、`ws`。Node 专有部分（WebSocket 服务器、`toNodeHandler`、PGlite）移到可选子路径导出，例如 `@uncage/hub/node`、`@uncage/hub/pglite`，核心入口在 workerd/Edge 打包时不会引入 Node 内置模块。
- `hub.fetch(request): Promise<Response>` 是唯一必需的挂载点（已有的 browser API 本就是 Fetch 风格）；`toNodeHandler(hub)` + `hub.attach(server)` 保留给传统模式。

### 5.2 传输：两种，自动协商
- **WebSocket**（现状，传统模式默认）。
- **HTTP 流**（新增，FaaS 模式；任何能流式返回响应的平台都能用）：
  - 下行：agent 发起一个长请求（如 `GET <base>/agent/stream?cursor=<n>`），hub 以流（SSE 或 NDJSON）持续推送给这台机器的指令；在平台时长上限前由服务端主动以"请重连"结束（可配置，默认留足余量，例如 Vercel 默认配置下 ~250s），agent 立即带着 cursor 重连。
  - 上行：agent 用 `POST <base>/agent/events`（批量）回传事件、工具调用、文件块等。
  - **可续传与恰好一次**：下行指令进入持久化的"每机器发件箱"（store），带单调序号；agent 以 cursor 确认，重连后从 cursor 续传；上行消息带 agent 生成的幂等 id，hub 去重。工具调用、审批决定、文件拉取请求在断线重连下不重复执行、不丢失。
- **协商**：pairing/握手时 hub 告知支持的传输（`transports: ['ws','http']`，带各自 URL）；agent 优先 WebSocket，不可用或连接被反复切断时回退 HTTP 流。0.2 agent 只会 WS → FaaS 部署时 hub 给出明确错误提示"请升级 agent"（`minAgentVersion` 机制已存在）。
- 心跳、在线状态在 HTTP 流下同样成立（下行流活跃 + 定期上报）。

### 5.3 跨实例：ClusterAdapter 增加 Postgres 实现
- 现有 `ClusterAdapter`（publish/subscribe/presence）保持接口不变；新增 `postgresCluster({ ... })`：基于消息表 + 短间隔轮询（默认约 300ms，可配），在线状态用带过期时间的行。可选地在支持 LISTEN/NOTIFY 的连接上用通知降低延迟，但不依赖它（serverless HTTP 驱动不支持）。
- 存储：`sqlHubStore` 已有可注入的 `SqlClient`；提供面向 serverless HTTP 驱动（如 Neon `@neondatabase/serverless`）的薄适配与文档示例，不把具体驱动作为硬依赖。
- 一个 Postgres 同时承担 store + cluster，开发者只配 `DATABASE_URL`。Redis cluster 仍可选，用于更低延迟。
- 需要清理：消息表与发件箱有保留期（已确认的、过期的）定期删除，不让表无限增长。

### 5.4 工具执行与文件拉取在 FaaS 下
- 工具 handler 在处理"工具调用"上行 POST 的那个函数实例中执行；需要 `ctx.files.pull` 时，通过发件箱向机器下发请求，响应经上行 POST 到达任意实例后经 cluster 路由回等待的实例。必须遵守平台时长：文档写清 handler 时长建议；超时给出用户可理解的错误。
- 浏览器侧 SSE（`browser-api` 已有）在 FaaS 下同样需要"到点主动结束 + 客户端带 Last-Event-ID 续上"；`@uncage/client`/`@uncage/react` 已有重连则验证，不足则补齐。

### 5.5 接入形态（开发者看到的）
- **Next.js（Vercel 等）**：`app/api/uncage/[...path]/route.ts` 里 `export const { GET, POST, ... } = toNextHandlers(hub)`（或直接 `hub.fetch`），`export const maxDuration`；hub 用 `postgresHubStore` + `postgresCluster`；无自定义服务器。
- **Cloudflare Workers**：`export default { fetch: (req, env) => hub(env).fetch(req) }`，Postgres 走 Neon HTTP 驱动或 Hyperdrive；`wrangler.toml` 示例。
- **传统 Node**：现状不变（`toNodeHandler` + `hub.attach`）。
- **其他 Fetch 平台**（Deno、Bun、Netlify）：文档给最小示例，说明需要 Postgres。
- 每种接入都有可直接复制的完整最小示例，和 0.2 一样经过 snippet 类型检查。

### 5.6 demo 与示例
- `examples/connected-demo`：同一份业务代码（工具、技能、页面），两种入口：`server.ts`（传统模式，Railway）与 Next route handler（FaaS 模式，Vercel）。由环境变量或文件约定切换，文档写清。demo 的登录、素材存储也不能依赖本地磁盘：FaaS 模式下素材存 Postgres（或 Vercel Blob 可选），cookie 密钥来自环境变量。
- 新增 `examples/connected-cloudflare`：最小 Worker 接入（一个站点工具 + 技能），`wrangler dev` 本地可跑通。

### 5.7 文档（帮助站，三语）
- 新增 **"Choose a deployment mode / 选择部署模式 / デプロイモードの選び方"**：一张对比表（传统 vs FaaS：依赖、延迟、成本、平台），一个决策流程（"你的网站在哪里？"→ 对应页面）。
- 平台接入页：Node（传统）、Next.js on Vercel、Cloudflare Workers、其他 Fetch 平台；每页：前提、完整代码、环境变量、部署步骤、验证清单、常见问题。
- 更新：how-it-works（传输协商图）、mount-the-hub、multi-node（FaaS 即天然多实例）、troubleshooting（504/超时、连接被切断、旧 agent）、reference（新 API、HTTP 传输协议）、for-coding-agents 与 `skills/uncage/SKILL.md`（让 coding agent 能按平台选对接法）、llms.txt。
- 官网：Coming soon 卡片 "Serverless-ready transport" → 已支持；三语。

### 5.8 版本
- 0.3.0（minor，fixed group 全部包一起）。按用户既定流程：我方准备 release 分支（版本号、changelog），用户只发 PR。

## 5.9 审阅后补充的裁定（我方判断）

1. **包结构（破坏性）**：`@uncage/hub` 根入口就是只含 Web 标准 API 的核心（任何平台可用）；Node 专有部分（`toNodeHandler`、WebSocket `attach`、`pgliteHubStore`）移到 `@uncage/hub/node`。不做条件导出；`createHub` 必须显式传 `store`（不再默认 PGlite）。构建检查保证根入口产物无 Node 内置模块。`Hub` 接口去掉 `attach`（改由 `@uncage/hub/node` 提供 `attachWebSocket(hub, server)` 之类的函数）。
2. **agent 版本**：hub 要求 agent ≥ 0.3（`minAgentVersion` 默认 0.3.0）。协议可借机统一整理，不保留 0.2 兼容路径。旧 agent 连接时：传统模式经 WebSocket 收到 `upgrade_required`（0.2 agent 已支持自升级）；FaaS 模式下 0.2 agent 无法握手，**在网站端提示**升级（电脑卡片/连接页：“请运行 `npm i -g @uncage/cli@latest` 后重新连接”）。
3. **Vercel 上的 demo 要支持公开模式**（与 Railway 版等价，可以替代它）。因此框架层面：
   - **限流与防暴力破解计数**（设备码、验证码失败次数、每 IP 限流）在 FaaS 模式下改为经 store 共享（Postgres），不再只在单实例内存里——这对所有 FaaS 用户都是安全必需，不只为 demo。
   - **定期清理**改为"顺带清理"（请求中按概率/间隔触发，带分布式锁），并可选用平台定时任务（Vercel Cron）调用一个清理端点；文档给出两种方式。
   - **请求体上限**：上行消息和文件拉取分块大小默认 ≤ 1 MB，适配 Vercel 约 4.5 MB 请求体上限；demo 素材在 FaaS 模式下存 Postgres（bytea），配额（每访客 20 个、单个 20 MB）保持，文件分块传输。
4. **成本**：FaaS 模式要能在 **Vercel Hobby 上支撑 demo 级别**（少量同时在线电脑）。传输做**自适应**：有运行中的会话时快速轮询（约 300 ms），空闲时退避到数秒；下行流时长、轮询间隔都可配置。帮助站"选择部署模式"里写清成本特征（每台在线电脑约占一个持续的函数调用）和何时该换传统模式或加 Redis。
5. **工具执行语义**：连接断开时保证**恰好一次**（持久化调用状态与结果、幂等 id 去重、断线重投递）。若函数实例本身在 handler 执行中被平台终止，则**至多一次**：该次工具调用标记失败，向用户和 Claude Code 返回可理解的错误（"网站工具执行超时，请重试"），不自动重跑。文档建议 handler 保持在平台时长内、尽量幂等。契约测试同时注入"连接切断"和"模拟实例终止"。

## 6. 验收

1. **协议层**：hub + agent 在 HTTP 流传输下的契约测试：断线重连续传无丢失无重复；工具调用、审批、文件拉取在随机切断下恰好一次；0.2 agent 连接 FaaS 部署得到清晰错误。
2. **跨实例**：多 hub 实例 + `postgresCluster`（真实 Postgres，docker）场景测试：机器流、浏览器、工具 POST 落在不同实例仍正常。
3. **Vercel 形态本地验证**：connected-demo 以 FaaS 入口用 `next build && next start`（不使用自定义服务器）+ 本地 Postgres 运行，人为设置短的流时长（如 30s）以频繁触发重连；真实 Claude Code 跑通完整链路（连接 → 流式 → 审批 → 站点工具 → 发布 → 刷新历史在 → 离线）。
4. **Cloudflare 形态本地验证**：`examples/connected-cloudflare` 用 `wrangler dev`（workerd）+ 本地 Postgres；真实 Claude Code 跑通"连接 → 一次带站点工具的运行"。核心入口打包无 Node 内置模块（构建检查）。
5. **传统模式回归**：0.2 全部测试与 Railway 形态 demo（容器）仍通过。
6. **文档**：新页面三语齐全，`check-i18n` 严格通过，代码片段类型检查通过，链接检查通过；官网卡片更新。
7. 全量 build/test/typecheck/lint 绿；推送分支 + PR 描述；release 分支准备好。

## 7. 留给实现者
HTTP 流的具体帧格式（SSE vs NDJSON）、发件箱表结构、轮询与清理间隔的默认值、`toNextHandlers` 的命名、demo 切换模式的具体方式、Cloudflare 示例用 Hono 还是原生。

## 8. 风险
- 轮询延迟与数据库负载：默认值需在真实 Postgres 上测；文档给出调优与"上 Redis"的指引。
- 平台限制会变（Vercel WebSocket、时长）：传输设计不依赖具体数值，重连时长可配置。
- workerd 兼容性（Node 依赖残留、驱动差异）：用构建检查 + `wrangler dev` 实跑兜底。
- 工作量大：按任务拆分，逐个审查；协议层先行。
