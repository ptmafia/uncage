---
title: "一个 agent，所有网站"
description: "让已经运行 Uncage 的电脑一键连接另一个 Uncage 网站：uncage:// 链接处理程序、uncage connect、带网站身份检查（域名、IDN、IP、首次连接、相似域名）的原生确认框、本地 dashboard，以及钓鱼威胁模型。"
---

用户只需要安装一次 Uncage 守护进程（agent）。之后每个嵌入了 Uncage 的网站都可以使用它，不必再开终端：网站显示一个链接，用户点击，在自己的电脑上确认，然后像往常一样在网站上批准。

:::note[状态]
已在 macOS、Linux 和 Windows 上构建并做过单元测试。注册真实处理程序的测试会在 macOS、Linux 和 Windows 的 CI runner 上运行（使用一次性的 scheme 和临时主目录）。在用户自己电脑上的一键连接、真实的对话框，以及真实浏览器里的 dashboard：等待真机确认。
:::

## 工作原理

1. `uncage setup`（或 `uncage agent install`）安装后台守护进程，**并且**向操作系统注册 `uncage://` 链接的处理程序。`uncage agent uninstall` 会把它移除。
   - **macOS：** 一个按用户安装的小应用 `~/Library/Application Support/Uncage/UncageConnect.app`，向 LaunchServices 注册。不需要管理员权限。
   - **Linux：** `~/.local/share/applications/uncage-connect.desktop`，并对 `x-scheme-handler/uncage` 执行 `xdg-mime default`。缺少 `xdg-mime` 时会跳过并给出提示。
   - **Windows：** `HKCU\Software\Classes\uncage`（仅当前用户）。
2. 你的网站显示**已经在这台电脑上使用 Uncage？一键连接**：`<ConnectMachine>` 面板链接到 `uncage://connect?url=<你的网站>`（hub 的 [`installInfo.connectUrl`](/docs/zh-cn/reference/http-api/)；在手机上隐藏）。安装命令仍是首选路径，因为网页无法判断处理程序是否存在。
3. 操作系统运行 `uncage connect <链接>`：它校验链接，显示**原生确认框**，只有点击“连接”后才开始正常的设备流程：浏览器打开网站的 `/device` 页面，用户点击批准。
4. 新网站被保存到 `~/.uncage/agent.yaml`，后台守护进程随之重启。

你也可以手动运行：`uncage connect https://app.example.com`。见 [CLI 参考](/docs/zh-cn/reference/cli/)。

## 接受什么样的链接

`uncage connect` 接受只带**一个**参数的 `uncage://connect?url=<网站>`，或者直接给一个网址。在做任何其他事情之前，它会拒绝符合下列任一条件的网站地址：

- 不是 `https://`（纯 `http://` 只允许 `localhost`、`127.0.0.1`、`[::1]`），
- 带有用户名或密码、查询或片段，
- 含有空格或控制字符，或长度超过 2048 个字符，
- 使用其他 scheme（`javascript:`、`data:`、`file:`），或其他 `uncage://` 动作或参数。

## 确认框与网站身份检查

在做任何配对之前，这台电脑上会弹出一个对话框：**要将这台电脑连接到 `example.com` 吗？** 它首先显示网站的**可注册域名**（来自公共后缀列表，包括 `vercel.app` 这类私有后缀，所以那里的每个项目都是独立的所有者），然后是完整的 hub 地址，以及连接意味着什么：用户使用该网站时，它可以在这台电脑上启动 coding agent 会话。**默认是取消。** 对话框使用系统语言（英文、中文或日文）。

下面每一种情况都会增加一行警告：

| 警告 | 何时出现 |
| --- | --- |
| 国际化字符 | 主机名是 IDN；会显示它的 punycode 形式。 |
| 纯 IP 地址 | 网站是一个 IP，而不是域名。 |
| 特定页面 | 路径既不是根路径，也不是默认的 `/api/uncage`：在共享的 origin 上，路径可能属于域名所有者之外的人。 |
| 首次连接 | 这台电脑以前从未连接过这个可注册域名。 |
| 与另一个网站相似 | 标签与某个已连接域名的相似字符骨架相同（数字和西里尔字母、希腊字母被映射为拉丁字母，`rn` ≈ `m` 等），或与之的编辑距离不超过 2。 |

各操作系统上询问的方式：

| 系统 | 对话框 |
| --- | --- |
| macOS | `/usr/bin/osascript`（提示框，10 分钟无人响应则按“否”处理） |
| Windows | 带“确定”和“取消”的 PowerShell `MessageBox`（默认取消），通过系统自带的 PowerShell 调用 |
| Linux | `zenity`，没有则用 `kdialog`，前提是有显示环境（`DISPLAY` 或 `WAYLAND_DISPLAY`） |

如果没有对话框工具，或者对话框无法显示（没有图形会话），而命令是在终端里运行的，就会在终端里询问 `Connect? [y/N]`。既没有对话框也没有终端时，它会拒绝，并打印手动运行的方法。**没有对话框，就没有连接。** 另外：

- 同一时间只问一个问题：反复触发链接的网页无法叠出多个对话框。
- 用户确认之后，hub 给出的审批页必须在已确认的 origin 上，应答的网站也必须是已确认的地址；否则什么都不会保存。
- 网站自己声明的名字，不会在不显示域名的情况下单独显示。
- 退出码：`0` 已连接，`1` 取消或被拒绝，`2` 链接无效。

## 本地 dashboard

`uncage dashboard` 会为这台电脑已连接的网站打开一个页面：

- 每个网站的名称和域名、machine id、连接时间、状态（在线、离线、已吊销）和传输方式、提供给它的运行时，以及最近（已脱敏）的活动；
- **断开连接**：在网站上吊销机器令牌（与 `uncage sites remove` 相同）并重启守护进程；
- 开启或关闭 ACP agent（与 `uncage runtimes enable|disable` 的同意规则相同），以及只读的本地策略视图。

它是 `127.0.0.1` 上随机端口的页面。链接里带有一次性密钥，会换成 `HttpOnly`、`SameSite=Strict` 的 cookie；每个请求都必须有正确的 `Host`（`127.0.0.1:<端口>`，用来防御 DNS rebinding）、没有外部 `Origin`，并带有密钥，否则返回 `403`。没有任何 CORS 头。页面关闭后，或 30 分钟没有请求后，它会退出（`--no-browser` 只打印链接，不打开浏览器）。页面使用系统语言。

## 威胁模型

一键连接让钓鱼变得更便宜：任何网页都可以触发 `uncage://connect?url=https://evil.example`。如果它悄悄生效，在自己网站上已登录的攻击者就会把受害者的电脑批准到**他的**账号下，然后就能在那里驱动用户的 coding agent。阻止这件事的是：

- **原生确认框**在网页之外显示是谁在请求，并且默认选“否”。网页无法替用户点击它。
- **身份警告**让相似域名、IDN、IP 主机和首次连接的网站格外显眼。
- **设备流程不变：** 确认之后，用户仍然必须在网站的 `/device` 页面批准验证码，那里会核对验证码并显示这台电脑。
- **没有中心注册表：** Uncage 不为任何网站背书。对话框展示的是链接所说的事实，而不是结论；用户只应确认自己刚刚发起的连接。
- 已连接的网站在电脑上能做什么并没有改变：见[信任模型](/docs/zh-cn/concepts/trust-model/)、[本地策略](/docs/zh-cn/guides/local-policy/)和逐个工具的审批。dashboard 会显示并可吊销每一个连接。

另见[安全](/docs/zh-cn/reference/security/)。
