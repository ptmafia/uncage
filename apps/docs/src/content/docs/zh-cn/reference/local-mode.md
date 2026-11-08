---
title: Local 模式详解
description: 输入框的各项控制、附件、绕过权限、配置（uncage.config.yaml）、代理的主机名与源校验，以及 Local 模式 Uncage 服务的安全模型。
---

这一页汇集 Local 模式（`uncage serve` + 同源代理）的细节。除特别说明外，输入框和附件在 Connected 模式下的行为相同。

## 输入框

`<AgentChat>` 的提示词输入框（Claude Code 风格）有以下控制项。每一项都会真正改变运行时收到的内容；针对真实 Claude Code 的实机 E2E 测试套件覆盖了模型、推理强度、各权限模式（包括绕过权限）、附件和运行中标签。

| 控制项 | 作用 |
| --- | --- |
| **模型**（闪光图标） | 运行时自己的模型列表。对 Claude Code 来说就是 `supportedModels()`，`default` 排在最前 |
| **推理强度**（大脑图标） | `low`、`medium`、`high`、`xhigh`、`max` |
| **权限**（盾牌图标） | `default`（执行命令和修改文件前询问）、`acceptEdits`（修改文件不询问，执行命令仍会询问）、`plan`（只做计划，不做任何改动）、`auto`（由运行时决定哪些需要你确认）。`bypassPermissions` 只在允许时出现（见下文） |
| **添加附件**（+）、拖放、粘贴 | 图片显示为缩略图，其他文件显示为标签。粘贴的截图会变成附件，粘贴的文本仍是文本 |
| **语音输入**（麦克风） | 通过浏览器的 Web Speech API 听写。浏览器不支持时隐藏 |
| **N 个运行中**标签 | 任一会话中正在进行的运行。点击可跳转过去 |
| **发送 / 停止** | Enter 发送，Shift+Enter 换行，输入法正在组字时按 Enter 不会发送。停止会取消这次运行 |

设置按会话保存。发出第一条提示词之前，设置属于草稿，在创建会话时生效。在已打开的会话里，修改**从下一次运行开始**生效；进行中的运行及其未处理的审批卡片保持开始时的设置。

**语音隐私。** 语音识别由浏览器完成，而不是 Uncage。在 Chrome 里，音频会发送到 Google 的语音服务。Uncage 只能看到识别出的文本。首次使用时会显示一条说明。

## 绕过权限

`bypassPermissions` 让 agent 不经询问执行任何命令、修改任何文件。它默认关闭，关闭时从不提供；伪造的请求会得到 `403 policy_denied`。

- **Local 模式：** 在 `uncage.config.yaml` 里设置 `security.allowBypass: true`，或用 `UNCAGE_ALLOW_BYPASS=1` 启动 Uncage 服务。`uncage serve` 随后会打印一条警告。
- **Connected 模式：** 只有用户本人可以开启，方法是在自己电脑的 `~/.uncage/agent.yaml` 里设置 `localPolicy.allowBypass: true`（见[本地策略](/docs/zh-cn/guides/local-policy/)）。

即便如此，在界面里选择**完全放行**时仍会要求确认，开启期间会一直显示红色横幅（“已开启完全放行”）。

:::caution
只在你能接受 agent 未经审查就做出改动的机器和工作区上允许绕过权限。它可以删除文件，也可以运行你的用户账号能运行的任何东西。
:::

## 附件

- 图片：`png jpg jpeg gif webp`。文件：`txt md json csv yaml yml xml html css js ts tsx jsx py go rs java rb sh sql log pdf`。
- 每个文件最大 10 MB，每条消息最多 10 个文件。Claude Code 对图片的上限是 5 MB（Anthropic API 的限制）。
- Claude 以内联方式接收图片。其他文件以路径传递，由 Claude 用自己的工具读取。
- Local 模式把上传的文件存在会话工作区的 `<workspace>/.uncage/attachments/<sessionId>/<attachmentId>-<name>`；从未发送的上传 24 小时后删除。Uncage 创建 `.uncage/` 时会写入 `.uncage/.gitignore`（`*`），所以附件永远不会被提交。git 工作区没有忽略 `.uncage/` 时，`uncage doctor` 会给出警告。
- `useAttachmentUrl` / `client.attachmentUrl` 返回你的同源代理下的 URL。普通的 `<img src>` 不会发送 `Authorization` 请求头，之所以能加载，是因为代理在服务器端加上了 Uncage 服务的令牌。
- Connected 模式：上传经过 hub（`POST <basePath>/sessions/:id/attachments`，最大 10 MiB）发送到用户电脑，用一个帧或若干 256 KiB 的分块传输。

## 配置

不做任何配置也能用。也可以在运行 `uncage serve` 的目录下添加 `uncage.config.yaml`。未知的键会被拒绝，错误信息里会写出名称。

```yaml
server:
  port: 4783
  eventRetentionDays: 7
security:
  allowedOrigins: []      # origins allowed to call the daemon directly (CORS-style); keep empty with the proxy
  approvalTtlMs: 600000
  allowBypass: false      # true offers the bypassPermissions mode (no approvals). Env: UNCAGE_ALLOW_BYPASS=1
workspace:
  allowedRoots: [/Users/me/code]
  default: /Users/me/code/my-app
runtimes:
  claude: { enabled: true }
  codex: { enabled: true }  # command: [codex, app-server]
```

代理的环境变量（在你的应用里）：`UNCAGE_URL`（默认 `http://127.0.0.1:4783`）、`UNCAGE_TOKEN`（默认读取 `~/.uncage/token`）、`UNCAGE_ALLOWED_HOSTS`。如果你用 `--token-file` 启动 Uncage 服务，请把那个令牌以 `UNCAGE_TOKEN` 的形式传给应用。

## 安全模型（Local 模式）

- **只监听回环地址。** Uncage 服务绑定在 `127.0.0.1:4783`。`Host` 不是 `127.0.0.1:<port>` 或 `localhost:<port>` 的请求会得到 403。
- **Bearer 令牌。** 每个 `/v1/*` 调用都需要 `Authorization: Bearer <token>`。令牌在 `~/.uncage/token`（权限 600）里。它从不写入日志、从不放进事件，也从不发送给浏览器。没有令牌：401。
- **不接受跨源的浏览器请求。** 带 `Origin` 请求头的请求会得到 403，除非这个源列在 `security.allowedOrigins` 里（默认为空）。浏览器只能通过你的同源代理访问 Uncage 服务。
- **代理同样拒绝跨源请求。** `Origin` 与浏览器所在的源（请求协议加上它的 `Host` 请求头）不同的请求会得到 `403 forbidden_origin`；带有 `Sec-Fetch-Site: cross-site` 标记的非 GET 请求也一样。协议和端口相同时，回环地址的各种名称算作同一个源（`localhost:3000` = `127.0.0.1:3000`）。
- **DNS 重绑定防护。** 代理只响应允许的主机名，依据浏览器的 `Host` 请求头检查。默认是 `localhost`、`127.0.0.1` 和 `[::1]`，端口不限。如果你的应用通过其他主机名提供（局域网名称、开发域名、内网穿透），请把它列出来：

  ```ts nocheck
  createUncageHandler({ allowedHosts: ['app.example.com', 'localhost'] });
  // or: UNCAGE_ALLOWED_HOSTS=app.example.com,localhost
  ```

  这个列表会**替换**默认值，所以如果你仍在使用回环地址的名称，请把它们加回去。只写主机名本身（不带协议和端口）。在反向代理后面时，请转发原始的 `Host`（nginx：`proxy_set_header Host $host;`）。
- **默认需要审批。** 新会话使用 `permissionMode: 'default'`。待审批项 10 分钟后过期。
- **工作区有边界。** 会话的工作区（经过 `realpath` 解析后）必须位于 `workspace.allowedRoots` 之内。默认是启动 `uncage serve` 时所在的目录，或 `--workspace` 指定的文件夹。
- **没有遥测。** 日志会隐去令牌和 authorization 请求头，在 info 级别下也不包含提示词文本。

## 嵌入 Uncage 服务

除了 `uncage serve`，你也可以在自己的 Node 进程里运行引擎：`@uncage/core` 的 `createUncage()` 配合 `@uncage/server` 的 `createUncageServer()`。见[自动生成的 API 参考](/docs/api/core/)。

## Codex 的状态

Codex 适配器（`@uncage/runtime-codex`，通过 stdio JSON-RPC 驱动 `codex app-server`）已经实现，但只对一个模拟的 app-server 验证过。它的协议已对照官方 schema 检查，但还没有对真实的 `codex` 二进制运行过。如果你想试用，必要时设置 `runtimes.codex.command`，并反馈你的发现。没有安装 Codex 时，界面和 `doctor` 会把它显示为**未安装**，并提示 `npm i -g @openai/codex && codex login`。Codex 暂不支持网站工具（Connected 模式）。
