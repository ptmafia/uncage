---
title: 概念
description: Uncage 背后的概念，一节一个：网站与 hub、电脑与守护进程、会话、运行、事件、审批与权限模式、网站工具、技能、清单、文件通道、存储、集群，以及信任模型。
---

这一页把每个概念讲一遍。全站对这些词的用法完全一致；一句话版本见[术语表](/docs/zh-cn/reference/glossary/)。

## 网站与 hub

**网站**就是你的 Web 应用。**hub**（`@uncage/hub`）是你用 `createHub()` 挂进网站后端的那部分 Uncage：可以挂在长期运行的 Node 进程里（**传统模式**），也可以挂在 Serverless 函数里（**FaaS 模式**，见[选择部署模式](/docs/zh-cn/start/choose-deployment-mode/)）。它是一个 Fetch handler（`hub.fetch`），在同一个基础路径（默认 `/api/uncage`）下提供：

- 你的界面使用的**浏览器 API**（请求和响应的形状与 Local 模式 Uncage 服务的 `/v1` API 相同，所以 `@uncage/client`、`@uncage/react` 和 `@uncage/react-ui` 无需修改即可使用）；
- 连接电脑时用的**设备端点**和安装脚本（`install.sh`、`install.ps1`）；
- 已连接电脑在 `<basePath>/agent` 主动接入的**传输方式**：**WebSocket**（传统模式，通过 `@uncage/hub/node` 中的 `attachWebSocket(hub, server)` 注册）和 **HTTP 流式传输**（任何平台）。hub 负责提供，守护进程从中选一种。

每个网站运行自己的 hub，中间没有任何 Uncage 云服务。

网站有一个 **id** 和一个**名称**，电脑连接时会看到。默认两者都取自 `publicUrl` 的主机名（如 `app.example.com`）；用 `site: { id, name }` 可以自定义。电脑用 id 命名本地目录，所以请保持它稳定。

## 电脑（machine）与守护进程（agent）

**电脑**（API 里叫 **machine**）是某个用户连接到你网站的一台电脑。一个用户可以连接多台；每台都有 id（`mch_…`）、名称、操作系统、agent 版本、可用的运行时（Claude Code、Codex），以及是否**在线**。

**守护进程**（API 和英文界面里叫 **agent**）是那台电脑上的后台进程：`uncage agent`，由 `uncage setup` 安装为按用户运行的后台服务（macOS 上是 launchd，Linux 上是 systemd，Windows 上是计划任务）。一个守护进程可以同时连接多个网站，每个网站各有一枚机器令牌、一条连接和一个工作区根目录。

当电脑的连接是活的（WebSocket 在响应心跳，或者有一条打开的 HTTP 流）时，它就是**在线**的。hub 每 10 秒 ping 一次，连续两次没有回应就标记为离线，所以界面会在约 30 秒内显示“离线”。

**配对**使用设备登录，和在电视应用上登录很像：`uncage setup <url>` 拿到一个简短的**验证码**（user code），用户在你网站的 `/device` 页面批准，CLI 随后获得**机器令牌**。令牌只保存在电脑上（`~/.uncage/agent.yaml`，权限 0600）；hub 只保存它的 SHA-256 哈希。吊销一台电脑（在你的网站上，或在电脑上运行 `uncage sites remove`）会让令牌立即失效。

## 会话（session）

**会话**是一段对话：一个运行时，在一台电脑上。会话 id 由电脑生成。hub 返回的每个会话都带有 `machineId`，你的界面可以据此显示那台电脑的状态。

- 在电脑上，每个会话有自己的**工作区**目录：`~/Uncage/<site host>/<session id>/`。浏览器无法指定目录。
- 会话的**数据以电脑本地数据库为准**（`~/.uncage/sites/<site id>/data`）。
- 新会话运行在你通过 `machineId` 指定的电脑上；不指定时，运行在该用户当前在线的电脑中最近活跃的那一台上。没有在线的电脑时，创建会话会失败并返回 `machine_offline`（如果用户从未连接过电脑，则是 `machine_not_found`）。

## 运行（run）

**运行**是一条提示词，以及 agent 为回答它所做的一切。一个会话同一时间最多只有一个进行中的运行（第二个会得到 `session_busy`）。运行状态：

| 状态 | 含义 |
| --- | --- |
| `queued`、`running` | 进行中 |
| `waiting_approval` | 停在一张审批卡片上 |
| `completed` | 正常结束 |
| `failed` | 出错结束 |
| `cancelled` | 用户点了停止 |
| `interrupted` | 运行中途进程没了（例如守护进程重启） |

开始一次运行需要 `Idempotency-Key` 请求头，这样重试的请求永远不会启动第二次运行。`@uncage/client` 会替你设置。

## 事件（event）

会话里发生的一切都是一个**事件**，带有会话内递增的**序号**（sequence）：`session.created`、`run.started`、`message.delta`、`tool.started`、`approval.requested`、`run.completed` 等等。浏览器通过 **SSE**（`GET <basePath>/sessions/:id/events`）接收它们，断线后可以从看到的最后一个序号继续（`Last-Event-ID`）。电脑先把事件写入本地数据库，所以断网时运行照常进行；连接恢复后，浏览器会补齐缺失的事件，不会重复。

## 审批与权限模式

当 Claude Code 要执行命令、修改文件，或调用需要确认的工具时，运行会暂停，界面弹出**审批卡片**（**允许执行** / **拒绝**）。决定从浏览器经 hub 送到电脑，由电脑原子地判定：如果两个标签页（或两个 hub 节点）同时作答，先到的决定生效，另一个得到 `409`。待审批项 10 分钟后过期。

会话的**权限模式**决定哪些操作需要审批：

| 模式 | 行为 |
| --- | --- |
| `default` | 执行命令和修改文件前询问（Claude Code 仍会自动放行它认为安全的操作，比如读取） |
| `acceptEdits` | 修改文件不询问；执行命令仍会询问 |
| `plan` | 只做计划，不做任何改动 |
| `auto` | 由运行时决定哪些需要用户确认 |
| `bypassPermissions` | 从不询问。**只有用户在自己电脑上打开后才可用**（见[信任模型](/docs/zh-cn/concepts/trust-model/)） |

## 网站工具（site tool）

**网站工具**是 Claude Code 可以调用的你网站的一项能力，用 `defineTool({ name, description, input, handler, requiresConfirmation? })` 声明。

- 电脑只收到名称、描述和 `input` 的 JSON Schema。Claude Code 把工具看作 `mcp__site__<name>`。
- **handler 在你的后端运行**，在持有这台电脑连接的 hub 节点上执行，`ctx.user` 是会话所属用户。
- `requiresConfirmation: true` 会让每次调用都先弹出审批卡片，即使是 `bypassPermissions` 模式。
- 每次调用都会被检查（会话属于这台电脑和用户、这次运行提供了这个工具、参数符合 `input`），并记录在 hub 的存储里。

指南：[定义网站工具](/docs/zh-cn/guides/define-tools/)。

## 技能（skill）

**技能**是一份说明（Markdown）加上可选的模板文件，声明为 `SkillSpec`（`{ name, description, markdown, files? }`）。运行开始前，守护进程把它写到会话工作区的 `.claude/skills/<name>/SKILL.md`，Claude Code 会像加载普通 Claude Code 技能一样，在任务符合描述时加载它。技能是数据，绝不是 hub 要执行的代码。

指南：[编写技能](/docs/zh-cn/guides/write-skills/)。

## 清单（manifest）

**清单**是提供给某一次运行的工具和技能。默认是你注册的全部工具和技能。用 `selectManifest({ user, prompt, sessionId, runtime })` 可以按次选择，比如只给付费用户提供发布类工具，或者只在提示词与发票有关时提供 `invoice` 技能。hub 会记录每次运行的工具列表；调用列表以外的工具会失败，返回 `tool_failed`（`details.reason: 'not_in_manifest'`）。你对工具或技能的修改从下一次运行开始生效。不支持网站工具的运行时（Codex）只拿到技能，会话里会出现 `site_tools_unsupported` 警告。

指南：[按运行选择工具和技能](/docs/zh-cn/guides/select-manifest/)。

## 文件通道（file channel）

**文件通道**让工具 handler 从电脑上这次运行的工作区读取文件，而不是把整个文件塞进 JSON 参数：`ctx.files.pull(path)`（一个文件或文件夹，总共最多 50 MiB，单个文件最多 10 MiB）和 `ctx.files.read(path)`（单个文件）。电脑会拒绝工作区以外的路径，从不跟随符号链接，并在拉取文件夹时跳过有多个硬链接的文件。

指南：[定义网站工具 → 从用户电脑读取文件](/docs/zh-cn/guides/define-tools/#从用户电脑读取文件)。

## 存储

有两处存储：

- **电脑上：** 会话数据（以此为准），PGlite，位于 `~/.uncage/sites/<site id>/`。
- **hub 上（`HubStore`）：** 电脑、设备码、会话索引（哪个用户拥有哪个会话、在哪台电脑上）、运行清单、经 hub 上传的附件，以及工具调用审计。在 FaaS 模式下，它还保存每台电脑的 **outbox**（还没处理的、带编号的命令）和工具调用结果。`pgliteHubStore`（内嵌，单进程，来自 `@uncage/hub/node`）用于传统模式；`postgresHubStore` 用于多节点和 FaaS 模式。`store` 必须显式传入其中一个。

**会话存储**（`sessionStorage` 选项）决定 hub 是否也保存对话：

- `'machine'`（默认）：历史从电脑读取。电脑离线时，用户看不到过去的对话。
- `'site'`：电脑按顺序把每个事件复制到 hub，重连后从最后一个已确认的序号继续补传。电脑关机时，历史在你的网站上仍然可读。

指南：[网站侧存储](/docs/zh-cn/guides/site-storage/)。

## 集群（cluster）

hub 可以在负载均衡后面运行多个**节点**；在 FaaS 模式下，每个函数实例都是一个节点。一台电脑的 WebSocket 落在某一个节点上，而浏览器请求可能落在另一个节点上。**集群适配器**（`ClusterAdapter`）共享“哪个节点持有哪台电脑”的信息，并在节点之间传递命令、唤醒信号和事件。`memoryCluster()`（默认）用于单进程；`redisCluster()` 或 `postgresCluster()` 用于多节点。所有节点还必须共享同一个 `HubStore`（Postgres）。

指南：[多节点](/docs/zh-cn/guides/multi-node/)。

## 本地策略与活动日志

用户的电脑说了算。在 `~/.uncage/agent.yaml` 里，`localPolicy.allowBypass`（默认 `false`）是唯一能让 `bypassPermissions` 生效的开关，`localPolicy.allowedPermissionModes` 可以限制任何网站能使用的模式。网站引起的每条命令、每次工具调用、每次文件拉取和每次审批都会写进本地**活动日志**，用 `uncage activity` 查看。

指南：[本地策略](/docs/zh-cn/guides/local-policy/)。

## 信任模型

网站被信任代表它的已登录用户行事，但有一些网站无法改变的限制：网站不能下发代码或 shell，绕过权限只能由用户打开，所有操作都有本地记录。详见[信任模型](/docs/zh-cn/concepts/trust-model/)。

## Local 模式

以上讲的都是 **Connected 模式**。在 **Local 模式**下没有 hub，也没有配对：`uncage serve`（**Uncage 服务**，英文叫 daemon）和你的应用运行在同一台机器上，你的应用通过同源**代理**（`@uncage/server/proxy` 里的 `createUncageHandler`）访问它，代理在服务器端加上 Uncage 服务的 bearer 令牌。会话、运行、事件和审批的工作方式完全相同。见 [Local 模式快速上手](/docs/zh-cn/start/quickstart-local/)。
