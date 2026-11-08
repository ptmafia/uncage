---
title: 故障排查
description: 常见问题的解决方法：在电脑上安装（找不到命令、Node.js 被删除、Linux 的驻留和没有 systemd、Windows 执行策略、unzip）、Connected 模式（电脑连不上、显示离线、需要更新守护进程、setup 出错、工具没被调用、Serverless 上的 504 和超时、连接被切断、连接池、代理后面的 WebSocket）和 Local 模式（Uncage 服务连不上、forbidden_origin、端口、登录）。
---

## 在电脑上安装

一条命令的安装脚本，以及 macOS、Linux 和 Windows 上的后台守护进程。它们做了什么，见[在你的电脑上安装](/docs/zh-cn/start/install-on-your-computer/)。

### 安装后提示 `uncage: command not found`

请打开一个新终端：安装脚本对 `PATH` 的修改只在新终端里生效（macOS 和 Linux：shell 配置文件中的 `# >>> uncage >>>` 块；Windows：你的用户 `Path`）。如果你在“把 Node.js 22 设为你的默认 Node.js？”上回答了 **n**，安装脚本已经打印了 `uncage` 的完整路径和需要使用的 `PATH` 行；运行它，或者重新运行安装脚本并回答 **Y**。使用 fish 时，请自己把安装脚本打印的那一行加到配置里。

### 后台守护进程使用的 Node.js 被删除了

后台服务固定使用安装时的那个 Node.js。Homebrew 升级（`brew upgrade node` 或 `node@22`）会删除旧版本的目录，删除 nvm、fnm 等版本管理器里的某个版本也一样。`uncage doctor` 会显示 `✗ Background agent Node … no longer exists`。让服务改用你现在使用的 Node.js：

```sh
uncage agent install
```

### Linux：注销后守护进程停止了

除非开启了驻留（linger），systemd 用户服务会在注销时停止（`uncage doctor` 会警告）。为你的用户开启它：

```sh
loginctl enable-linger $USER
```

大多数发行版不需要 `sudo` 就能执行；如果被拒绝，请联系管理员。

### Linux 上没有 systemd

部分容器和 WSL 环境没有用户级 systemd。这时 `uncage setup` 和 `uncage agent install` 会说明这一点，不安装服务。请在前台运行守护进程，例如放在 `tmux` 或 `screen` 里：

```sh
uncage agent
```

### Windows：“在此系统上禁止运行脚本”

PowerShell 默认的执行策略会拒绝运行 `uncage.ps1`，这是 npm 在 `uncage.cmd` 旁边生成的 shim。请改用 `uncage.cmd`（例如 `uncage.cmd setup https://your.site`），或者为你的用户允许本地脚本：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

安装脚本本身不受影响：`irm … | iex` 不需要脚本文件。

### Linux：“安装 fnm 需要 unzip”

没有 Node.js 版本管理器时，安装脚本会安装 fnm，而 fnm 的安装脚本需要 `unzip`。安装脚本从不调用你的包管理器，所以请自己安装 `unzip`（`sudo apt install unzip`、`sudo dnf install unzip` 等），再运行一次命令。也可以用你喜欢的任何方式安装 Node.js 22，然后再运行命令。

## Connected 模式

### `uncage setup` 失败或一直不结束

- **“Refusing plain http for …”**：守护进程只对 `localhost`、`127.0.0.1` 和 `[::1]` 接受 `http://`。请使用你网站的 `https://` URL。
- **链接能打开，但没有批准按钮**：这个验证码未知、已被使用或已超过 10 分钟。重新运行 `uncage setup <url>`。检查你的 `/device` 页面是否把 `code` 查询参数传给了 `hub.lookupDevice`。
- **“Too many requests” / `rate_limited`**：同一 IP 申请的设备码过多（每分钟 20 个），或同一用户输错验证码过多（每 10 分钟 10 次）。如果很多用户同时遇到，见下一节。
- **那台电脑没有浏览器**：`uncage setup <url> --no-browser` 会打印链接和验证码；在任意一台已登录该用户的设备上打开链接。
- **`UNCAGE_HOME is for foreground runs`**：设置了 `UNCAGE_HOME` 时，请使用 `--no-daemon`，并自己运行 `uncage agent`。

### 很多用户同时遇到 `uncage setup` 以 `429 rate_limited` 失败

设备码的限制（每分钟 20 个）是**按客户端 IP** 计算的。在反向代理、负载均衡或 CDN 后面，除非你配置了客户端 IP，hub 看到的都是代理的地址，于是所有用户落进同一个桶，一分钟内的第 21 次 setup 对所有人都会失败。

- **Express：** `app.set('trust proxy', 1)`（数字是前面的代理层数），并用 `toNodeHandler(hub)` 挂载 hub，它会传入 `req.ip`。
- **Vercel 上的 Next.js：** `toNextHandlers` 会自己读取 Vercel 的 `x-real-ip`；如果 Vercel 前面还有别的代理，请传入它的 `clientIp` 选项。
- **Cloudflare Workers：** 给 `fetchOnce` 传入 `clientIp: req.headers.get('cf-connecting-ip') ?? undefined`。
- **其他 Fetch 风格的服务器（Hono 等）：** `createHub({ rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined } })`，换成你所用平台的客户端 IP 请求头；或者调用 `hub.fetch(req, { clientIp })`。
- **`rateLimits.trustForwardedFor: true`**，仅当你的代理会把客户端地址追加到 `X-Forwarded-For` 时使用。

计数保存在 store 中，由所有节点和函数实例共享。详见[反向代理或负载均衡之后](/docs/zh-cn/guides/mount-the-hub/#反向代理或负载均衡之后)。

### 页面一直显示“等待你的电脑上线…”

1. 在电脑上：`uncage sites` 应该把你的网站列为 `active`。
2. 守护进程在运行吗？`uncage agent status` 会显示后台服务及其使用的 Node.js；或者先停掉服务（`uncage agent uninstall`），再在终端里运行 `uncage agent` 查看输出。日志：`~/.uncage/logs/agent.log` 和 `agent.err.log`。
3. hub 提供了什么？`curl -s https://your.site/api/uncage/agent/info` 必须返回带 `"transports"` 的 JSON。如果返回的是 HTML 页面或 404，说明 hub 没有挂载在那个路径上。
4. 传统模式：你的服务器必须在提供 `publicUrl` 的同一个 HTTP 服务器上调用 `attachWebSocket(hub, server)`，前面的每一层代理都应该转发 `<basePath>/agent` 上的 WebSocket 升级。（升级失败时，守护进程会在三次尝试后切换到 HTTP 流式传输，所以单是 WebSocket 被拦截，已经不会让电脑一直离线。）
5. FaaS 模式：守护进程必须是 0.3 或更新版本（见[需要更新守护进程](#需要更新守护进程--426-upgrade_required)），平台也必须以流式返回响应（见[流被切断](#电脑反复重连或者流被切断)）。
6. `publicUrl` 必须是用户打开的 URL。安装和 setup 命令，以及守护进程使用的传输方式 URL，都来自它。

### 守护进程在运行，电脑却显示离线

- 笔记本休眠或网络切换：守护进程会以退避方式重连（1 秒，最多 30 秒）。运行在本地继续进行，重连后事件会补齐。
- 负载均衡的空闲超时低于约 30 秒会断开 WebSocket。请调高它；hub 每 10 秒 ping 一次。
- `uncage agent status` 显示安装服务时用的 Node.js 不见了（Homebrew 升级过，或者删除了某个 nvm/fnm 版本）：重新运行 `uncage agent install`。
- 这台电脑已在你的网站上被吊销：`uncage sites` 显示 `revoked`。重新运行 `uncage setup <url>`。
- 守护进程太旧：见下一节。

### “需要更新守护进程” / 426 `upgrade_required`

hub 要求守护进程是 0.3 或更新版本（`minAgentVersion`）。

- **传统模式（WebSocket）：** hub 告诉守护进程 `upgrade_required`，守护进程会用 `npm i -g @uncage/cli@latest` 自行升级，然后重新连接。如果那台电脑上的 npm 需要 `sudo`，升级就会失败；请修改 npm 的全局前缀（`npm config set prefix ~/.npm-global`，并把它的 `bin` 加进 `PATH`），然后重新安装。重新运行你网站的安装命令也能自动完成这些步骤。
- **FaaS 模式（Vercel、Workers 等）：** 0.2 守护进程只会用 WebSocket，而 FaaS 模式的 hub 不提供 WebSocket。它会收到 `426 upgrade_required`，hub 把这台电脑标记为版本过旧，网站会在这台电脑的卡片上和对话中显示**需要更新守护进程**（`<AgentOutdatedNotice>`、`MachineInfo.agentOutdated`）。在那台电脑上运行：

  ```sh
  npm i -g @uncage/cli@latest
  uncage setup https://your.site
  ```

  `uncage --version` 第一行输出 CLI 版本，第二行输出运行它的 Node.js。

### Serverless 上出现 504 错误或“FUNCTION_INVOCATION_TIMEOUT”

有请求超过了平台的时间上限。

- **守护进程的流和浏览器的事件流：** 把 `stream.maxDurationMs` 设在上限以下并留出余量（Vercel `maxDuration = 300` → `250_000`，即默认值）。这样 hub 会自己结束它们，客户端立即重连。
- **网站工具调用：** 每次调用都在一个请求里执行，所以 `toolTimeoutMs`（120 秒）也必须放得进上限。被平台停止的 handler 会以“Site tool "<name>" timed out on the website. Please try again.”失败，并且不会重新执行。
- **上传：** 如果在 `bodyTimeoutMs`（30 秒）内没有收到任何字节，或者整个请求体用时超过它的 4 倍，请求体会被以 `400` 拒绝。慢但持续的上传可以顺利完成；只有停滞的连接才会失败。
- **在 Vercel 上超过约 4.5 MB 的附件**会在 hub 运行之前收到 Vercel 自己的 `413`。见 [Vercel → 常见问题](/docs/zh-cn/deploy/vercel/#超过约-4-mb-的附件发送失败)。

### 电脑反复重连，或者流被切断

连接被切断是预料之中的事，也没有危害：守护进程会带着游标重连，什么都不会丢失，也不会重复送达。只有在一直稳定不下来时才需要细查：

- 守护进程日志里**每隔几分钟出现一次 `http stream rotated`** 是正常的（hub 在 `stream.maxDurationMs` 时结束流）。
- **每隔几秒就报错**：有东西过早关闭了长请求（代理或 CDN 的超时）。把那个超时调到 `stream.maxDurationMs` 以上，或者把 `stream.maxDurationMs` 调到它以下。
- **响应一次性全部到达**（提示词的回复到最后才出现）：有代理缓冲了流。为 `<basePath>/sessions/*/events` 和 `<basePath>/agent/stream` 关闭缓冲（nginx：`proxy_buffering off;`）；hub 会在守护进程的流上发送 `X-Accel-Buffering: no`，但并非所有代理都会遵守。
- **`/agent/*` 返回 `429`**：某个带错误令牌的守护进程（例如一台已被吊销但仍在运行的电脑）触发了 `agentAuthFailuresPerMinute`。响应带有 `Retry-After` 头，守护进程会等待相应的时长。在那台电脑上，`uncage sites` 会列出这个网站；重新运行 `uncage setup <url>`。
- **电脑一直在重试，不显示 `revoked`，守护进程日志里有“HTTP 401 that is not the hub refusing the token; retrying”**：网站前面有东西用自己的 401 回复了守护进程，例如预览部署上的 Vercel Deployment Protection 或 Cloudflare Access。只有响应体是 hub 自己的 `{ "error": { "code": "unauthorized" } }` 的 401 才会吊销电脑。放行守护进程（为 `/api/uncage/agent` 设置绕过，或改用正式环境的 URL），它就会自动重连。

### Postgres：连接池和 Serverless 驱动

- **事务模式的连接池**（PgBouncer、Neon 的 `-pooler` 主机）可以配合 `postgresHubStore` 和 `postgresCluster` 使用：迁移使用事务级锁。
- **Neon 的 `neon()` HTTP 函数会失败**：hub 需要在同一个连接上执行事务。请使用 `pg`，或者 `@neondatabase/serverless` 中 Neon 的 `Pool`。
- **连接数过多**：每个函数实例都会打开自己的连接池。请使用带连接池的 URL，并让每个连接池保持很小（`max: 5`），由 store 和 cluster 共用。
- **`Connection terminated` 让 Node 进程崩溃**：给你自己创建的每个连接池挂上 `pool.on('error', …)`。

### 电脑关机后历史消失了

这是 `sessionStorage: 'machine'`（默认值）的行为。使用 `sessionStorage: 'site'` 可以在你的网站上保存副本（[网站侧存储](/docs/zh-cn/guides/site-storage/)）。

### Claude Code 不调用我的工具

- 工具不在这次运行的清单里：检查 `selectManifest`（未知的名称会被静默忽略）。
- 描述没有告诉模型什么时候该用它。写清楚它做什么、什么时候用；如果它是某个流程的一部分，就在技能里提到它。
- 会话使用的是 Codex（暂不支持网站工具）。
- 在对话里，工具步骤的错误会告诉你更多：`invalid_request`（参数不符合 `input`）、`tool_failed`（你的 handler 抛错、超时，或者 `not_in_manifest`）。

### 发送时出现“你的电脑离线了。请确认那台电脑上的守护进程（`uncage agent`）正在运行。” / `machine_offline`

选中的电脑离线了。在标题栏的电脑菜单里换一台，或者启动守护进程。

### `/device` 可以被嵌入框架，或者批准按钮没有反应

见[认证与设备授权](/docs/zh-cn/guides/auth-and-device-approval/#审批页device)：这个页面需要 `frame-ancestors 'none'`、`X-Frame-Options: DENY`，以及一个你的框架能接受的 POST 决定（Next.js 的 Server Action，或者带 Origin 校验的端点）。

### “The Uncage hub is not running: start the app with `node server.ts`”

你启动的是 `next dev`。hub 位于自定义服务器里；请用 `npm run dev`（`node server.ts`）启动。

## Local 模式

### “The Uncage daemon is not reachable” / “token was not found”

先启动 `npx uncage serve`。如果 Uncage 服务是用 `--token-file` 启动的，请把 `UNCAGE_TOKEN` 交给应用。

### 403 `forbidden_origin`

阅读错误消息；它会写出是哪个请求头。

- **“Host … is not allowed”**：浏览器发送的 `Host` 不是允许的主机名，例如你打开了 `next dev` 打印的 `Network:` URL、一个开发域名，或一个内网穿透地址。把这个主机名（不带端口）加到 `allowedHosts` / `UNCAGE_ALLOWED_HOSTS`。
- **“Origin … does not match Host …”**：浏览器和你的应用之间有东西改写了 `Host`。Vite 或 webpack 开发代理：`changeOrigin: false`。nginx：`proxy_set_header Host $host;`。

在 Connected 模式下，同一个错误码表示有跨站 POST 到达了 hub：请求的 `Origin` 既不是 `publicUrl`，也不是它自己的 `Host`。检查你的代理是否保留了 `Host`，以及 `publicUrl` 是否完全准确（包括协议和端口）。

### 端口 4783 被占用

另一个 `uncage serve` 正在运行；或者使用 `--port 4784`，并为应用设置 `UNCAGE_URL=http://127.0.0.1:4784`。

### Claude Code 显示“auth required”

运行 `claude`，输入 `/login`，然后重启 `uncage serve`（Local 模式）或守护进程（Connected 模式）。

## 还是解决不了？

- `npx uncage doctor`（Local 模式）：每项失败的检查都会打印修复方法。
- `uncage activity --follow`（Connected 模式，在电脑上运行）：网站请求了什么，哪里失败了。
- 提交 issue 时附上错误里的 `requestId`；如果是会话问题，再附上 `uncage doctor --export-events <sessionId> --out events.json` 的输出（Local 模式；内容会被脱敏）：[github.com/ptmafia/uncage/issues](https://github.com/ptmafia/uncage/issues)。
