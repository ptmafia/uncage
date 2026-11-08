---
title: 错误码
description: Uncage 的每个错误码及其 HTTP 状态、是否可重试、含义和处理方法，包括 Connected 模式特有的错误码（machine_offline、tool_failed、upgrade_required、rate_limited）。
---

来自 hub、Uncage 服务、代理或工具调用的每个错误都具有相同的形状（`@uncage/protocol` 里的 `ErrorBody`）：

```json
{ "code": "tool_failed", "message": "…", "hint": "…", "retryable": true, "details": { "reason": "not_in_manifest" }, "requestId": "req_…" }
```

在 React 里，`useUncageError()` 以 `{ error: { code, message, hint, … } }` 的形式返回它；`<AgentChat>` 会用界面语言显示消息和提示。

| 错误码 | 状态 | 可重试 | 含义与处理方法 |
| --- | --- | --- | --- |
| `unauthorized` | 401 | 否 | 没有已登录用户（`getUser` 返回了 `null`）、Uncage 服务的令牌缺失或错误，或者机器令牌未知。请登录；Local 模式下请检查 `UNCAGE_TOKEN`。 |
| `forbidden_origin` | 403 | 否 | 发往 hub 的跨站请求，或者代理的 `Host` / `Origin` 校验失败。消息里会写出是哪个请求头。见[故障排查](/docs/zh-cn/reference/troubleshooting/#403-forbidden_origin)。 |
| `not_found` | 404 | 否 | 没有这个会话、运行、审批或附件，**或者它属于其他用户**。`ctx.files.read` 的路径不存在，或者工具调用所属的运行 hub 不认识（`details.reason: 'run_not_indexed'`）时也会返回它。 |
| `invalid_request` | 400 | 否 | 请求体或参数不符合 schema。对网站工具来说：参数不符合 `input`（handler 没有运行），或者文件通道的路径超出了工作区，或对 `read` 指定了文件夹。 |
| `machine_offline` | 409 | 是 | 用户的电脑没有连接。界面会等待它；用户应启动守护进程（`uncage agent`，或检查后台服务）。 |
| `machine_not_found` | 404 | 否 | 该用户没有这台电脑，或者还没有连接任何电脑（“先连接你的电脑”）。 |
| `upgrade_required` | 426 | 否 | 守护进程的版本低于 hub 的 `minAgentVersion`。守护进程会自我升级（`npm i -g @uncage/cli@latest`）并重新连接。 |
| `tool_failed` | 502 | 是 | 网站工具调用失败：你的 handler 抛错（其消息会被传递）、超时（`toolTimeoutMs`）、结果过大，或者 `details.reason` 为 `not_in_manifest` 或 `too_many_concurrent`。 |
| `policy_denied` | 403 | 否 | 被策略拒绝：没有 `localPolicy.allowBypass`（Connected）或 `security.allowBypass`（Local）却使用 `bypassPermissions`，或者使用了 `localPolicy.allowedPermissionModes` 以外的模式。 |
| `rate_limited` | 429 | 是 | 同一 IP 申请的设备码过多，或同一用户输错验证码的次数过多（`details.retryAfterSec`）。 |
| `device_code_expired` | 410 | 否 | setup 验证码已超过 10 分钟。重新运行 `uncage setup <url>`。 |
| `session_busy` | 409 | 是 | 会话已有一个进行中的运行。等待它结束，或停止它。 |
| `session_read_only` | 409 | 否 | 会话无法再继续（例如 Claude Code 丢失了它的原生会话）。新建一个会话。 |
| `approval_expired` | 410 | 否 | 审批等待超过了 10 分钟。重新发起。 |
| `approval_already_resolved` | 409 | 否 | 有人（另一个标签页、另一个节点）先做了决定。刷新页面。 |
| `event_replay_unavailable` | 410 | 否 | 请求的事件已经不在了。获取一份新的快照，从它的 `lastSequence` 继续。 |
| `runtime_unavailable` | 503 | 否 | 那台电脑上没有安装该运行时（Claude Code、Codex）。 |
| `auth_required` | 401 | 否 | 运行时没有登录。运行 `claude`，然后输入 `/login`。 |
| `unsupported_capability` | 422 | 否 | 运行时做不到这件事，例如它不支持的附件类型、设置或审批选项。（在 Codex 会话上使用网站工具不会被拒绝：运行照常开始，只是不带工具，并显示 `site_tools_unsupported` 警告。） |
| `runtime_disconnected` | 502 | 是 | 运行时进程在运行中途退出了。开始一次新的运行；历史会保留。 |
| `invalid_workspace` | 400 | 否 | Local 模式：工作区不在 `workspace.allowedRoots` 之内。 |
| `store_locked` | 423 | 是 | 另一个进程正在使用同一个数据目录（第二个 Uncage 服务，或者两个 hub 共用一个 PGlite 目录）。 |
| `attachment_too_large` | 413 | 否 | 超过 10 MB（Claude Code 的图片为 5 MB）。 |
| `attachment_type_unsupported` | 415 | 否 | 不是允许的图片或文件类型。 |
| `internal_error` | 500 | 否 | bug 或意外故障（`selectManifest` 抛错或挑选了过多工具时也会返回它）。根据 `requestId` 查看服务器日志。 |

## 模型看到的工具错误

网站工具失败时，Claude Code 会把错误作为工具结果接收，并且通常会尝试纠正，所以**错误消息是你产品的一部分**：“No order ord_9 in your account.”有帮助；“TypeError: cannot read properties of undefined”没有帮助，还可能泄露内部信息。见[定义网站工具 → 错误](/docs/zh-cn/guides/define-tools/#错误)。
