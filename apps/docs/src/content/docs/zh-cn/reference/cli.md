---
title: CLI 参考
description: uncage 的所有命令和参数，包括 Connected 模式（setup、agent、sites、activity）和 Local 模式（serve、doctor），以及它们读取的环境变量。
---

`@uncage/cli` 提供 `uncage` 命令。终端用户通过你网站的 `install.sh`（或 `npm i -g @uncage/cli`）获得它；Local 模式的应用通过 `npx uncage …` 使用它。每个命令都支持 `--help`。

## Connected 模式（在用户电脑上）

### `uncage setup <url>`

```text
uncage setup <url> [--no-daemon] [--no-browser]
```

把这台电脑连接到一个网站。`<url>` 就是你网站上显示的地址：网站的源，例如 `https://app.example.com`。没有路径的 URL 会自动补上 `/api/uncage`（挂在其他基础路径上的 hub 会显示完整 URL，按原样使用）；没有协议的 URL 会补上 `https://`。

1. 申请一个设备码，并打印链接和码。
2. 在浏览器里打开链接（`open`），由已登录用户批准。
3. 等待批准，然后把网站和机器令牌保存到 `~/.uncage/agent.yaml`（权限 0600）。
4. 安装并（重新）启动后台守护进程（launchd：`~/Library/LaunchAgents/dev.uncage.agent.plist`）。

| 参数 | |
| --- | --- |
| `--no-daemon` | 不安装也不启动后台守护进程；你自己运行 `uncage agent`。 |
| `--no-browser` | 不打开浏览器，只打印链接和码（适用于没有浏览器的电脑：在另一台设备上打开链接）。 |

纯 `http://` 只对 `localhost`、`127.0.0.1` 和 `[::1]` 有效。

### `uncage agent`

```text
uncage agent              # run in the foreground
uncage agent uninstall    # stop and remove the background agent; config and data stay
```

连接 `~/.uncage/agent.yaml` 里的每个网站并为它们服务。没有网站时正常退出。想手动运行它，请先停掉后台服务。

### `uncage sites`

```text
uncage sites                 # ID, NAME, HOST, MACHINE, STATUS
uncage sites remove <id>     # disconnect a website
```

`remove` 会在网站上吊销这台电脑（用它自己的令牌调用 `POST <hub>/machine/revoke`），从 `agent.yaml` 里删除令牌，并重启后台守护进程。本地会话数据（`~/.uncage/sites/<id>`）和工作区（`~/Uncage/…`）会保留。

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

检查 Node、数据目录、令牌、正在运行的 Uncage 服务和运行时（Claude Code、Codex）。每一行是 ✓ 或 ✗，每个 ✗ 都会打印一条 `fix:` 命令。当服务的工作区是一个没有忽略 `.uncage/` 的 git 仓库时，以及在把令牌发往非回环 URL 之前，它会给出警告（`!`，不致命）。

`--export-events` 把一个会话的事件导出为 JSON，用于提交 bug 报告；除非加上 `--include-content`，内容会被脱敏。

查找 Uncage 服务的顺序：`--url`、`--port`、`UNCAGE_URL`、`UNCAGE_PORT`、`uncage.config.yaml`，最后是 `4783`。

## 环境变量

| 变量 | 使用者 | |
| --- | --- | --- |
| `UNCAGE_HOME` | Connected 模式的命令 | 绝对路径，用来替换 `~/.uncage` 和 `~/Uncage` 中的 `~`（开发和测试用）。除非加 `--no-daemon`，`uncage setup` 会拒绝它。`HOME` 不变，所以 Claude Code 的登录状态保持不变。 |
| `UNCAGE_LOG_LEVEL` | `serve`、`agent` | 日志级别，例如 `debug` |
| `UNCAGE_PORT` | `serve`、`doctor` | Uncage 服务的端口 |
| `UNCAGE_URL` | `doctor`、Local 模式的代理 | Uncage 服务的 URL（默认 `http://127.0.0.1:4783`） |
| `UNCAGE_ALLOW_BYPASS=1` | `serve` | 在 Local 模式下提供 `bypassPermissions`（会打印警告） |
| `UNCAGE_TOKEN` | Local 模式的代理 | Uncage 服务的令牌，当它不在 `~/.uncage/token` 时使用 |
| `UNCAGE_ALLOWED_HOSTS` | Local 模式的代理 | 允许的 `Host` 名称（逗号分隔） |

在 Connected 模式下，绕过权限只由 `~/.uncage/agent.yaml` 里的 `localPolicy.allowBypass` 控制（见[本地策略](/docs/zh-cn/guides/local-policy/)）。
