---
title: HTTP API
description: hub 浏览器 API、设备端点和安装脚本的所有路由，它们与 Local 模式 Uncage 服务的 /v1 API 的对应关系，以及请求体、请求头、SSE 和错误响应。
---

你很少需要自己调用这些接口：`@uncage/client`（以及基于它的 React 包）会替你调用。这里列出它们，供自定义客户端、调试和 coding agent 参考。所有请求体的类型都在 `@uncage/protocol` 里。

## 两种服务器，同一套 API 形状

| | Connected 模式的 hub | Local 模式的 Uncage 服务 |
| --- | --- | --- |
| 基础地址 | `<publicUrl><basePath>`（默认 `/api/uncage`） | `http://127.0.0.1:4783/v1`，通过你在 `/api/uncage` 的代理访问 |
| 认证 | 你的 cookie，经由 `getUser(req)` | `Authorization: Bearer <token>`，由代理添加 |
| 额外内容 | `/machines`、设备端点、`install.sh`、守护进程的 WebSocket | 无 |

会话、运行、事件和审批路由在两者中的请求和响应形状相同。所以同一个客户端两边都能用：把它指向 `/api/uncage`，它就会和 hub 或代理通信。

## 浏览器 API

下面所有路由都需要已登录用户（否则返回 `401 unauthorized`）。其他用户的资源返回 `404`，和不存在的资源一样。来自其他源的非 GET 请求得到 `403 forbidden_origin`。

| 方法和路径 | 请求体 / 查询参数 | 响应 |
| --- | --- | --- |
| `GET /health` | | `{ ok: true, protocol: "1.0", version }` |
| `GET /runtimes` | `?machineId=`（可选） | 那台电脑的 `RuntimeInfo[]`，不指定时为第一台在线电脑的 |
| `GET /machines` | | `MachineInfo[]`：`{ id, name, os, agentVersion, runtimes, online, lastSeenAt }`，最近在线的排在最前 |
| `GET /machines/install` | | `{ install, setup, windows: null }`：要展示的两条命令 |
| `DELETE /machines/:id` | | `{ ok: true }`。吊销这台电脑 |
| `GET /sessions` | | `Session[]`，每个都带 `machineId`，最早的排在最前 |
| `POST /sessions` | `{ runtime, title?, machineId? }` | `201 Session`。不传 `machineId` 时使用最近在线的电脑。`workspace` 会被忽略 |
| `GET /sessions/:id` | | `SessionSnapshot`：`{ session, runs, pendingApprovals, lastSequence }` |
| `PATCH /sessions/:id/settings` | `{ model?, effort?, permissionMode? }`（至少一项） | `Session` |
| `POST /sessions/:id/runs` | `{ prompt, attachmentIds? }` + 请求头 `Idempotency-Key` | `202 Run` |
| `GET /sessions/:id/events` | `?after=<sequence>` 或请求头 `Last-Event-ID` | `UncageEvent` 的 SSE 流。带 `Accept: application/json` 时返回 JSON 数组（`?limit=`） |
| `POST /sessions/:id/attachments` | 原始字节；请求头 `Content-Type`、`X-Filename`（URI 编码） | `Attachment`。最大 10 MiB |
| `GET /attachments/:id` | | 文件本身 |
| `GET /runs?active=1` | | `ActiveRunInfo[]`：该用户各会话中正在进行的运行 |
| `GET /runs/:id` | | `Run` |
| `POST /runs/:id/cancel` | | `202` |
| `GET /approvals?sessionId=` | | 该会话待处理的 `ApprovalRequest[]` |
| `POST /approvals/:id/decision` | `{ decision: "allow" \| "deny", scope: "once" \| "session", reason? }` + 请求头 `Idempotency-Key` | 更新后的 `ApprovalRequest`。第二个不同的决定会得到 `409` |

Local 模式的 Uncage 服务在 `/v1` 下有同样的路由，但没有 `/machines*`，并且在 `POST /v1/sessions` 里接受 `workspace`（必须位于允许的根目录之内）。

### Server-sent events

`GET /sessions/:id/events` 以 `text/event-stream` 推送。每个事件都把自己的序号作为 SSE 的 `id`，所以重连的 `EventSource`（或 `@uncage/client`）可以通过 `Last-Event-ID` 继续。每 15 秒（`sseHeartbeatMs`）发送一行注释，防止代理关闭事件流。你会看到这些事件：`session.created`、`session.updated`、`run.started`、`run.updated`、`run.completed`、`run.failed`、`run.cancelled`、`run.interrupted`、`message.started`、`message.delta`、`message.completed`、`tool.started`、`tool.updated`、`tool.completed`、`tool.failed`、`approval.requested`、`approval.updated`、`approval.resolved`、`system.warning`。

## 电脑一侧（公开）

供 CLI 和守护进程使用。它们不调用 `getUser`。

| 方法和路径 | |
| --- | --- |
| `GET /install.sh` | 安装脚本（`text/plain`）。内容固定；只有 CLI 版本范围会变化 |
| `POST /device/code` | 发起设备登录。返回验证码、验证链接、轮询间隔（2 秒）和过期时间（600 秒）。按客户端 IP 限流 |
| `POST /device/token` | `{ deviceCode }`：轮询直到用户批准；然后返回一次机器令牌 |
| `POST /machine/revoke` | `Authorization: Bearer <machine token>`：电脑吊销自己（`uncage sites remove`） |
| `GET /agent`（WebSocket 升级） | 守护进程的连接（`Authorization: Bearer <machine token>`），由 `hub.attach(server)` 注册。协议版本 1；帧为 JSON，每帧最大 1 MiB |

## 错误

每个错误都是 JSON，HTTP 状态码与错误码对应：

```json
{ "code": "machine_offline", "message": "The machine is offline.", "hint": "Make sure the Uncage agent is running on that machine and connected to the internet.", "retryable": true, "requestId": "req_…" }
```

在有用的地方会附加 `details`（例如 `details.reason`、`details.retryAfterSec`）。完整列表见[错误码](/docs/zh-cn/reference/errors/)。
