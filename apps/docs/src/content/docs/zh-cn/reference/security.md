---
title: 安全
description: Connected 模式（传输、机器令牌、设备登录、用户之间的隔离、工具执行、文件通道、各项限制）和 Local 模式的安全特性，以及给网站开发者的检查清单。
---

[信任模型](/docs/zh-cn/concepts/trust-model/)讲的是网站可以在用户电脑上做什么。这一页列出这些规则是如何强制执行的。

## 传输

协议版本为 `2`。守护进程始终是**主动连出**，所以用户不需要开放任何端口。hub 提供其中一种或两种传输方式（`transports` 选项）；守护进程优先使用 WebSocket，连续三次失败后回退到 HTTPS 流式传输。

- **WSS**（传统模式）：每台电脑一个 WebSocket。hub 每 10 秒 ping 一次；连续两次没有响应的电脑会显示为离线。
- **HTTPS 流式传输**（FaaS 模式，以及回退方式）：`POST <basePath>/agent/connect` 建立一条链路，`GET <basePath>/agent/stream` 返回 NDJSON 行（每行一个 JSON 对象：带序号的 hub 帧，以及每 10 秒一次的 `{"ctl":"ping"}`），守护进程用 `POST <basePath>/agent/events` 发送它的消息。每个请求都在 `Bearer` 头里带上机器令牌。流在 `stream.maxDurationMs` 之后结束，守护进程立即重连。带着 `cursor` 重新打开流，就等于确认了它之前的所有帧，所以断开的流既不会丢帧，也不会重复已确认的帧；上行消息有幂等 id，重试不会被应用两次。
- 除非 hub 位于 `localhost`、`127.0.0.1` 或 `[::1]`（开发环境），否则拒绝纯 `ws://` / `http://`。
- 帧和请求体都是 JSON，双方都会对照协议 schema 校验，每个最大 1 MiB。版本低于 `minAgentVersion` 的守护进程会被 hub 拒绝（WebSocket：`upgrade_required`；HTTP：`426 upgrade_required`）。
- 对 `/agent/*` 的请求如果机器令牌缺失或错误，会按客户端 IP 限流（`rateLimits.agentAuthFailuresPerMinute`，60 次），计数保存在存储里。
- 在线状态：无论哪种传输方式，一台电脑静默超过两次 ping 的间隔（约 30 秒）就会显示为离线。

## 机器令牌

- 每台电脑每个网站一枚令牌：32 个随机字节，base64url 编码。
- 只保存在电脑上的 `~/.uncage/agent.yaml` 里（权限 0600；更宽松的权限会被收紧）。hub 只保存它的 SHA-256 哈希。
- 从不写入日志、从不放进事件、从不发送给浏览器。
- 可以从网站吊销（`hub.revokeMachine`、`DELETE <basePath>/machines/:id`），也可以从电脑吊销（`uncage sites remove`）。被吊销的令牌立即失效，它的连接会被关闭。
- 重新配对同一台电脑（配对时它会发送一个随机的 `machineKey`）会轮换令牌并保留 machine id；使用旧令牌的连接会被关闭。

## 设备登录

- 验证码：从去掉了易混淆字符的 31 个字符（`ABCDEFGHJKMNPQRSTUVWXYZ23456789`）中取 8 个，10 分钟内有效，只能使用一次。
- 验证码只能由已登录用户通过你的 `/device` 页面批准，你必须保护这个页面免受框架嵌入和 CSRF 攻击（[指南](/docs/zh-cn/guides/auth-and-device-approval/#审批页device)）。
- 限流：每个客户端 IP 每分钟 20 个设备码；每个用户每 10 分钟最多 10 次失败的验证码查询或决定。计数保存在 hub 存储里，所有节点和函数实例共享。
- 设备码（CLI 轮询用的密钥）和用户码都以哈希形式保存。

## 用户之间的隔离

- 每个浏览器请求都用 `getUser(req)` 认证。
- 每个会话、运行、审批、附件和电脑都**连同其所有者**一起查询。其他用户的 id 返回 `404`，与不存在的无法区分。
- 电脑只能上报自己会话的事件，也只能为属于自己用户的会话、且经 hub 启动的运行调用工具。
- 来自其他源、会改变状态的浏览器请求会得到 `403 forbidden_origin`。

## 工具执行

- 工具 handler **在你的服务器上**运行。电脑只收到名称、描述和 JSON Schema。
- 工具名称不能包含 `__`，并且在电脑上带有命名空间（`mcp__site__<name>`），所以永远不会遮蔽 Claude Code 的内置工具。
- handler 运行前，参数会先用你的 zod schema 校验。
- 只接受这次运行清单里的工具调用；每次调用都会在 hub 存储里留下审计记录。
- `requiresConfirmation` 工具在每次调用、每种权限模式下都会询问用户。
- 超时（120 秒）、并发上限（每台电脑 8 个）和结果大小上限（略小于 1 MiB）限定了工作量。

## 文件通道

- 路径必须是相对路径，且位于会话工作区之内；电脑用 `realpath` 解析，拒绝任何外部路径。
- 从不跟随符号链接。拉取文件夹时跳过有多个硬链接的文件，单独读取这类文件时直接拒绝。
- 每次拉取最多 50 MiB，单个文件最多 10 MiB；拉取是全有或全无的。

## 在用户电脑上

- 每个会话在自己的目录 `~/Uncage/<site host>/<session id>/`（权限 0700）里运行，绝不进入已有的项目。浏览器无法指定目录。
- 技能只会写入该目录下的 `.claude/skills/<name>/`，且不跟随符号链接。
- `bypassPermissions` 需要电脑上设置 `localPolicy.allowBypass: true`；`localPolicy.allowedPermissionModes` 限制可用的模式。
- 网站做的一切都记录在 `~/.uncage/sites/<site id>/activity.log` 里（经过脱敏）。
- `install.sh` 内容固定；它只从 npm 安装 `@uncage/cli`，不做其他任何事。

## ACP agent

[其他 ACP agent](/docs/zh-cn/guides/use-any-acp-agent/)作为本地进程运行在用户的电脑上，使用它们自己的登录。用户受到这些规则的保护：

- **授权与完整的启动规格绑定。** 通过 `npx` 或 `uvx` 分发的 agent 会下载代码，所以只有在执行 `uncage runtimes enable <id>` 之后才会运行。授权记录了运行器、包（不限版本）、参数和环境变量；如果注册表之后改为运行别的东西，该 agent 会等待重新 `enable`。
- **注册表信任规则。** 来自 ACP 注册表的 agent，只有在这台电脑上已安装并通过 ACP 握手之后才会启用。注册表刷新后如果命令变了，它会被撤下，直到你重新启用。`autoDetect: false` 关闭检测；`disable` 不论其他设置如何都会阻止某个 agent。
- **项目配置文件不能授予授权。** 在 Local 模式下，`uncage.config.yaml` 里的 `enable` 和 `consented` 会被忽略。
- **项目配置文件里的 `agents[].command` 无需授权就会运行。** 项目的 `uncage.config.yaml` 可以列出任意命令，`uncage serve` 会启动它。`uncage doctor` 和 `uncage serve` 启动时会打印每一条这样的命令：只在你信任的项目里运行它们。
- **绝不选“始终允许”。** 对 ACP 的权限请求，Uncage 只回答 agent 提供的 `allow_once` 或 `reject_once` 选项，绝不选择 `allow_always` 或 `reject_always`，因为 agent 可能把它保存到会话之外。
- **网站工具通过回环 MCP 服务器。** 每次运行都会在 `127.0.0.1` 上开一个 MCP 服务器，带一次性的 bearer 令牌，通过 `mcpServers` 传给 agent；带 `requiresConfirmation` 的工具在每次调用前都会在 Uncage 里询问。handler 仍然运行在你的服务器上。
- **技能**只会写入会话目录下的 `.uncage/skills/<name>/`，并在第一条提示中列出。
- 注册表下载（`cdn.agentclientprotocol.com`，最多每天一次；`UNCAGE_ACP_REGISTRY_REFRESH=0` 可关闭）只提供名称、命令和图标，它本身不会运行任何东西。

## Local 模式

Uncage 服务只绑定回环地址，要求使用 `~/.uncage/token`（权限 600）里的 bearer 令牌，拒绝外来的 `Origin`，浏览器只能通过你的同源代理访问它，而代理会检查 `Host`（防 DNS 重绑定）和 `Origin`。详见 [Local 模式详解](/docs/zh-cn/reference/local-mode/#安全模型local-模式)。

## 给网站开发者的检查清单

- [ ] `getUser` 返回真实的已登录用户，或者 `null`；会话 cookie 设置了 `Secure`，以及 `SameSite=Lax` 或 `Strict`。
- [ ] `publicUrl` 是你的 `https://` 源，你的代理会转发原始的 `Host`。
- [ ] `/device` 要求登录，发送 `frame-ancestors 'none'` 和 `X-Frame-Options: DENY`，并用带 CSRF 防护的 POST 做决定。
- [ ] 每个工具 handler 都把读写范围限定在 `ctx.user.id` 之内。
- [ ] 工具错误信息可以安全地展示给用户；详细信息写进你的日志。
- [ ] 发布、发送、付款或删除类的工具使用 `requiresConfirmation: true`。
- [ ] 从电脑拉取的文件被当作不可信内容（在沙箱里提供，必要时扫描）。
- [ ] 在代理后面为限流配置了客户端 IP。
- [ ] 使用你自己的 Postgres 连接池或 Redis 客户端时，已挂上 `'error'` 监听器。
