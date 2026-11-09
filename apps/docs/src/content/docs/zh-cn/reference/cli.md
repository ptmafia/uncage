---
title: CLI 参考
description: uncage 的所有命令和参数，包括 Connected 模式（setup、agent install / uninstall / status、sites、runtimes、activity）和 Local 模式（serve、doctor）、uncage --version、一键安装脚本，以及它们读取的环境变量。
---

`@uncage/cli` 提供 `uncage` 命令。终端用户通过你网站的一键安装脚本获得它，或者用 `npm i -g @uncage/cli` 安装；Local 模式的应用通过 `npx uncage …` 使用它。每个命令都支持 `--help`。

```sh
curl -fsSL https://your.site/api/uncage/install.sh | bash        # macOS, Linux
irm https://your.site/api/uncage/install.ps1 | iex               # Windows PowerShell
```

安装脚本会检查电脑（Node.js 22+、npm、已安装的 coding agent），在每个步骤之前询问 `[Y/n]`（如果用户有版本管理器，就用它安装 Node.js；绝不使用 `sudo` 或管理员权限），安装 `@uncage/cli`，并询问是否为那个网站运行 `uncage setup`。参数、退出码和各操作系统的细节见[在你的电脑上安装](/docs/zh-cn/start/install-on-your-computer/)。

### `uncage --version`

```text
uncage --version
0.3.0
node v22.18.0 (/Users/ada/.local/share/fnm/node-versions/v22.18.0/installation/bin/node)
```

第一行是 CLI 版本；第二行是运行它的 Node.js 及其路径（也就是 `uncage agent install` 为后台守护进程固定使用的那个 Node.js）。

## Connected 模式（在用户电脑上）

### `uncage setup <url>`

```text
uncage setup <url> [--no-daemon] [--no-browser]
```

把这台电脑连接到一个网站。`<url>` 就是你网站上显示的地址：网站的源，例如 `https://app.example.com`。没有路径的 URL 会自动补上 `/api/uncage`（挂在其他基础路径上的 hub 会显示完整 URL，按原样使用）；没有协议的 URL 会补上 `https://`。

1. 申请一个设备码，并打印链接和验证码。
2. 在浏览器里打开链接（`open`），由已登录用户批准。
3. 等待批准，然后把网站和机器令牌保存到 `~/.uncage/agent.yaml`（权限 0600）。
4. 为当前用户安装并（重新）启动后台守护进程，效果与 `uncage agent install` 相同：macOS 上是 launchd（`~/Library/LaunchAgents/dev.uncage.agent.plist`），Linux 上是 systemd 用户服务，Windows 上是计划任务。如果没有服务管理器，它会打印如何在前台运行 `uncage agent`。

| 参数 | |
| --- | --- |
| `--no-daemon` | 不安装也不启动后台守护进程；你自己运行 `uncage agent`。 |
| `--no-browser` | 不打开浏览器，只打印链接和验证码（适用于没有浏览器的电脑：在另一台设备上打开链接）。 |

纯 `http://` 只对 `localhost`、`127.0.0.1` 和 `[::1]` 有效。

### `uncage agent`

```text
uncage agent [--log-file <path>]   # run in the foreground
uncage agent install               # install and start the background agent for this user
uncage agent uninstall             # stop and remove the background agent; config and data stay
uncage agent status [--json]       # installed? running? which Node.js?
```

`uncage agent` 连接 `~/.uncage/agent.yaml` 里的每个网站并为它们服务，每个网站提供哪种传输方式就用哪种（WebSocket 或 HTTP 流式传输）。没有网站时正常退出。想手动运行它，请先停掉后台服务。

| 参数 / 子命令 | |
| --- | --- |
| `--log-file <path>` | 把日志追加到这个文件，而不是 stderr。每次启动时都会限制日志文件的大小。 |
| `install` | 安装并启动按用户运行的后台服务，**固定使用运行这条命令的 Node.js**（它的真实路径，而不是版本管理器的 shim）：macOS 上是 launchd，Linux 上是 systemd 用户服务，Windows 上是计划任务（当前用户、最低权限；无法创建计划任务时改用注册表的 Run 项）。不需要管理员权限。更换或删除那个 Node.js 之后，请重新运行它。设置了 `UNCAGE_HOME` 时会拒绝执行。 |
| `uninstall` | 停止并删除服务。`~/.uncage/agent.yaml` 和数据会保留。 |
| `status` | 服务类型、是否已安装并在运行、服务定义文件、固定使用的 Node.js（以及它是否还存在）、CLI 入口和日志目录（`~/.uncage/logs`）。`--json` 以 JSON 输出同样的内容。 |
| `--supervise` | 内部使用：Windows 计划任务运行的是 `uncage agent --supervise`，它会在守护进程崩溃或自我升级后将其重启（任务计划程序本身不会这样做）。macOS 和 Linux 上不需要。 |

在 Linux 上，除非开启了驻留（linger），用户服务会在注销时停止：`uncage doctor` 会提示你，运行 `loginctl enable-linger $USER` 即可解决。Linux 和 Windows 已通过 CI 验证，尚待真机确认；macOS 已在真机上验证。

### `uncage sites`

```text
uncage sites                 # ID, NAME, HOST, MACHINE, STATUS
uncage sites remove <id>     # disconnect a website
```

`remove` 会在网站上吊销这台电脑（用它自己的令牌调用 `POST <hub>/machine/revoke`），从 `agent.yaml` 里删除令牌，并重启后台守护进程。本地会话数据（`~/.uncage/sites/<id>`）和工作区（`~/Uncage/…`）会保留。

### `uncage runtimes`

```text
uncage runtimes [--json] [--all] [--refresh]   # ID, NAME, STATUS, VERSION, SITE TOOLS, RESUME
uncage runtimes enable <id>                    # register an ACP registry agent (consent for npx/uvx)
uncage runtimes disable <id>                   # never register an ACP agent
```

列出 `uncage agent` 向网站提供的运行时：Claude Code、Codex，以及 `~/.uncage/agent.yaml` 中 `runtimes.acp` 配置的 ACP agent（预设、你自己写的条目，以及从 ACP registry 检测到的 agent），并显示它们的状态、是否支持网站工具和恢复会话。随后列出尚未注册的 ACP registry agent 及原因。

| 参数 | |
| --- | --- |
| `--json` | 以 JSON 输出 `{ runtimes, registry }` |
| `--all` | 同时列出这台电脑上没有安装的 registry agent |
| `--refresh` | 先下载最新的 ACP registry（否则使用缓存或自带的副本） |

`enable` 会打印将要运行的确切内容，并把你的同意记录到 `runtimes.acp.enable` / `consented`；通过 `npx` 或 `uvx` 分发的 agent 没有它就绝不会运行。`disable` 把 id 加入 `runtimes.acp.disable`。两者都会重启后台守护进程。详见[使用任意 ACP agent](/docs/zh-cn/guides/use-any-acp-agent/)。

### `uncage activity`

```text
uncage activity [--site <id>] [--follow] [--json]
```

显示已连接的网站让这台电脑做了什么：每条命令、每次网站工具调用、每次文件拉取和每次审批，以及连接、断开、吊销和升级。内容经过脱敏：保留 id、状态和错误码；不记录提示词、文件内容和工具参数。

| 参数 | |
| --- | --- |
| `--site <id>` | 只看这个网站（见 `uncage sites`） |
| `--follow`、`-f` | 持续打印新的记录 |
| `--json` | 每行一个 JSON 对象 |

## Local 模式（在运行你应用的机器上）

### `uncage serve`

```text
uncage serve [--port <n>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
```

在 `127.0.0.1` 上启动本地的 Uncage 服务（只监听回环地址）。

| 参数 | 默认值 |
| --- | --- |
| `--port <n>` | `4783`，或 `UNCAGE_PORT` |
| `--workspace <dir>` | 当前目录。agent 读写的目录。 |
| `--data-dir <dir>` | `~/.uncage/data`（会话和事件） |
| `--token-file <file>` | `~/.uncage/token`（bearer 令牌，创建时权限为 600） |

工作目录下可选的 `uncage.config.yaml`：见 [Local 模式详解](/docs/zh-cn/reference/local-mode/#配置)。

### `uncage doctor`

```text
uncage doctor [--port <n> | --url <url>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
uncage doctor --export-events <sessionId> [--out <file>] [--include-content] [--port <n> | --url <url>]
```

检查 Node、数据目录、令牌、正在运行的 Uncage 服务、Connected 模式的后台守护进程（是否已安装并在运行、固定使用的 Node.js 是否还在、Linux 的驻留（linger）、每个已连接网站对应的守护进程版本）和运行时（Claude Code、Codex，以及每个 ACP agent 各一行 `runtime.acp-<id>`，来自 `uncage.config.yaml` 的 `runtimes.acp` 或自动检测）。每一行是 ✓ 或 ✗，每个 ✗ 都会打印一条 `fix:` 命令。ACP 的行是可选的：这些行出现 ✗（例如未安装，fix 为安装提示）不会改变退出码。`uncage.config.yaml` 用自己的 `command` 添加的每个 ACP agent，还会多一行警告，显示它运行的命令。当服务的工作区是一个没有忽略 `.uncage/` 的 git 仓库时，以及在把令牌发往非回环 URL 之前，它会给出警告（`!`，不致命）。

`--export-events` 把一个会话的事件导出为 JSON，用于提交 bug 报告；除非加上 `--include-content`，内容会被脱敏。

查找 Uncage 服务的顺序：`--url`、`--port`、`UNCAGE_URL`、`UNCAGE_PORT`、`uncage.config.yaml`，最后是 `4783`。

## 环境变量

| 变量 | 使用者 | |
| --- | --- | --- |
| `UNCAGE_HOME` | Connected 模式的命令 | 绝对路径，用来替换 `~/.uncage` 和 `~/Uncage` 中的 `~`（开发和测试用）。除非加 `--no-daemon`，`uncage setup` 会拒绝它。`HOME` 不变，所以 Claude Code 的登录状态保持不变。 |
| `UNCAGE_LOG_LEVEL` | `serve`、`agent` | 日志级别，例如 `debug` |
| `UNCAGE_ACP_REGISTRY_REFRESH=0` | `agent` | 不每天下载 ACP registry（使用缓存或自带的副本） |
| `UNCAGE_PORT` | `serve`、`doctor` | Uncage 服务的端口 |
| `UNCAGE_URL` | `doctor`、Local 模式的代理 | Uncage 服务的 URL（默认 `http://127.0.0.1:4783`） |
| `UNCAGE_ALLOW_BYPASS=1` | `serve` | 在 Local 模式下提供 `bypassPermissions`（会打印警告） |
| `UNCAGE_TOKEN` | Local 模式的代理 | Uncage 服务的令牌，当它不在 `~/.uncage/token` 时使用 |
| `UNCAGE_ALLOWED_HOSTS` | Local 模式的代理 | 允许的 `Host` 名称（逗号分隔） |
| `UNCAGE_YES=1` | `install.sh`、`install.ps1` | 对每个安装步骤都回答“是”（`--yes` / `-Yes`） |
| `UNCAGE_NO_SETUP=1` | `install.sh`、`install.ps1` | 只安装，不提议运行 `uncage setup`（`--no-setup` / `-NoSetup`） |
| `UNCAGE_LANG` | `install.sh`、`install.ps1` | 安装脚本提示信息的语言：`en`、`zh` 或 `ja`（`--lang` / `-Lang`） |

在 Connected 模式下，绕过权限只由 `~/.uncage/agent.yaml` 里的 `localPolicy.allowBypass` 控制（见[本地策略](/docs/zh-cn/guides/local-policy/)）。
