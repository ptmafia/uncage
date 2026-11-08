---
title: 安全
description: Connected 模式（传输、机器令牌、设备登录、用户之间的隔离、工具执行、文件通道、各项限制）和 Local 模式的安全特性，以及给网站开发者的检查清单。
---

[信任模型](/docs/zh-cn/concepts/trust-model/)讲的是网站可以在用户电脑上做什么。这一页列出这些规则是如何强制执行的。

## 传输

- 守护进程通过 **WSS** **主动连出**到 hub。除非 hub 位于 `localhost`、`127.0.0.1` 或 `[::1]`（开发环境），否则拒绝纯 `ws://` / `http://`。用户不需要开放任何端口。
- 帧为 JSON，双方都会对照协议 schema 校验，每帧最大 1 MiB。协议版本为 `1`；版本低于 `minAgentVersion` 的守护进程会被 hub 以 `upgrade_required` 拒绝。
- hub 每 10 秒 ping 一次；连续两次没有响应的电脑会显示为离线。

## 机器令牌

- 每台电脑每个网站一枚令牌：32 个随机字节，base64url 编码。
- 只保存在电脑上的 `~/.uncage/agent.yaml` 里（权限 0600；更宽松的权限会被收紧）。hub 只保存它的 SHA-256 哈希。
- 从不写入日志、从不放进事件、从不发送给浏览器。
- 可以从网站吊销（`hub.revokeMachine`、`DELETE <basePath>/machines/:id`），也可以从电脑吊销（`uncage sites remove`）。被吊销的令牌立即失效，它的连接会被关闭。
- 重新配对同一台电脑（配对时它会发送一个随机的 `machineKey`）会轮换令牌并保留 machine id；使用旧令牌的连接会被关闭。

## 设备登录

- 用户码：从去掉了易混淆字符的 31 个字符（`ABCDEFGHJKMNPQRSTUVWXYZ23456789`）中取 8 个，10 分钟内有效，只能使用一次。
- 码只能由已登录用户通过你的 `/device` 页面批准，你必须保护这个页面免受框架嵌入和 CSRF 攻击（[指南](/docs/zh-cn/guides/auth-and-device-approval/#审批页device)）。
- 限流：每个客户端 IP 每分钟 20 个设备码；每个用户每 10 分钟最多 10 次失败的码查询或决定。按 hub 节点分别计数。
- 设备码（CLI 轮询用的密钥）和用户码都以哈希形式保存。

## 用户之间的隔离

- 每个浏览器请求都用 `getUser(req)` 认证。
- 每个会话、运行、审批、附件和电脑都**连同其所有者**一起查询。其他用户的 id 返回 `404`，与不存在的无法区分。
- 电脑只能上报自己会话的事件，也只能为自己用户的、经 hub 启动的会话中的运行调用工具。
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
- 从不跟随符号链接。拉取文件夹时跳过有硬链接的文件，单独读取这类文件时直接拒绝。
- 每次拉取最多 50 MiB，单个文件最多 10 MiB；拉取是全有或全无的。

## 在用户电脑上

- 每个会话在自己的目录 `~/Uncage/<site host>/<session id>/`（权限 0700）里运行，绝不进入已有的项目。浏览器无法指定目录。
- 技能只会写入该目录下的 `.claude/skills/<name>/`，且不跟随符号链接。
- `bypassPermissions` 需要电脑上设置 `localPolicy.allowBypass: true`；`localPolicy.allowedPermissionModes` 限制可用的模式。
- 网站做的一切都记录在 `~/.uncage/sites/<site id>/activity.log` 里（经过脱敏）。
- `install.sh` 内容固定；它只从 npm 安装 `@uncage/cli`，不做其他任何事。

## Local 模式

Uncage 服务只绑定回环地址，要求使用 `~/.uncage/token`（权限 600）里的 bearer 令牌，拒绝外来的 `Origin`，浏览器只能通过你的同源代理访问它，而代理会检查 `Host`（防 DNS 重绑定）和 `Origin`。详见 [Local 模式详解](/docs/zh-cn/reference/local-mode/#安全模型local-模式)。

## 给网站开发者的检查清单

- [ ] `getUser` 返回真实的已登录用户，或者 `null`；会话 cookie 设置了 `Secure`，以及 `SameSite=Lax` 或 `Strict`。
- [ ] `publicUrl` 是你的 `https://` 源，你的代理会转发原始的 `Host`。
- [ ] `/device` 要求登录，发送 `frame-ancestors 'none'` 和 `X-Frame-Options: DENY`，并用带 CSRF 防护的 POST 做决定。
- [ ] 每个工具 handler 都把读写范围限定在 `ctx.user.id` 之内。
- [ ] 工具错误对用户安全；详细信息写进你的日志。
- [ ] 发布、发送、付款或删除类的工具使用 `requiresConfirmation: true`。
- [ ] 从电脑拉取的文件被当作不可信内容（在沙箱里提供，必要时扫描）。
- [ ] 在代理后面为限流配置了客户端 IP。
- [ ] 使用你自己的 Postgres 连接池或 Redis 客户端时，已挂上 `'error'` 监听器。
