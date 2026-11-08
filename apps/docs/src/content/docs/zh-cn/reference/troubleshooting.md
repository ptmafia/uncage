---
title: 故障排查
description: 常见问题的解决方法：Connected 模式（电脑连不上、显示离线、setup 出错、工具没被调用、代理后面的 WebSocket）和 Local 模式（Uncage 服务连不上、forbidden_origin、端口、登录）。
---

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
- **Fetch 风格的服务器（Hono、Next route handler……）：** `createHub({ rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined } })`，换成你所用平台的客户端 IP 请求头；或者调用 `hub.handler(req, { clientIp })`。
- **`rateLimits.trustForwardedFor: true`**，仅当你的代理会把客户端地址追加到 `X-Forwarded-For` 时使用。

多节点时，限制在每个节点上分别计数。详见[反向代理或负载均衡之后](/docs/zh-cn/guides/mount-the-hub/#反向代理或负载均衡之后)。

### 页面一直显示“等待你的电脑上线…”

1. 在电脑上：`uncage sites` 应该把你的网站列为 `active`。
2. 守护进程在运行吗？`launchctl print gui/$(id -u)/dev.uncage.agent | head`（后台服务），或者在终端里运行 `uncage agent` 查看输出。日志：`~/.uncage/logs/agent.err.log`。
3. 它能连到 WebSocket 吗？你的服务器必须在提供 `publicUrl` 的同一个 HTTP 服务器上调用 `hub.attach(server)`，前面的每一层代理都必须转发 `<basePath>/agent` 上的 WebSocket 升级。最常见的原因是代理对升级请求直接返回 404 或 502。
4. `publicUrl` 必须是用户打开的 URL。安装和 setup 命令，以及守护进程据此推导出的 WebSocket URL，都来自它。

### 守护进程在运行，电脑却显示离线

- 笔记本休眠或网络切换：守护进程会以退避方式重连（1 秒，最多 30 秒）。运行在本地继续进行，重连后事件会补齐。
- 负载均衡的空闲超时低于约 30 秒会断开 WebSocket。请调高它；hub 每 10 秒 ping 一次。
- 这台电脑已在你的网站上被吊销：`uncage sites` 显示 `revoked`。重新运行 `uncage setup <url>`。
- 守护进程太旧（日志里有 `upgrade_required`）：它会用 `npm i -g @uncage/cli@latest` 自我升级。如果那台电脑上的 npm 需要 `sudo`，升级就会失败；请修改 npm 的全局前缀（`npm config set prefix ~/.npm-global`，并把它的 `bin` 加进 `PATH`），然后重新安装。

### 电脑关机后历史消失了

这是 `sessionStorage: 'machine'`（默认值）的行为。使用 `sessionStorage: 'site'` 可以在你的网站上保存副本（[网站侧存储](/docs/zh-cn/guides/site-storage/)）。

### Claude Code 不调用我的工具

- 工具不在这次运行的清单里：检查 `selectManifest`（未知的名称会被静默忽略）。
- 描述没有告诉模型什么时候该用它。写清楚它做什么、什么时候用；如果它是某个流程的一部分，就在技能里提到它。
- 会话使用的是 Codex（暂不支持网站工具）。
- 在对话里，工具步骤的错误会告诉你更多：`invalid_request`（参数不符合 `input`）、`tool_failed`（你的 handler 抛错、超时，或者 `not_in_manifest`）。

### 发送时出现“Creating the session failed” / `machine_offline`

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
