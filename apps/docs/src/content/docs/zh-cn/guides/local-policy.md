---
title: 本地策略与用户的电脑
description: 终端用户在自己电脑上能控制什么：~/.uncage/agent.yaml 与 localPolicy（allowBypass、allowedPermissionModes）、活动日志、目录、后台守护进程、断开网站，以及本地扩展。
---

这一页讲的是**用户一侧**：运行 `uncage agent` 的那台电脑。网站开发者也应该了解它，因为它划定了你的网站能请求什么。背后的原因见[信任模型](/docs/zh-cn/concepts/trust-model/)。

## 文件和目录

| 路径 | 内容 |
| --- | --- |
| `~/.uncage/agent.yaml` | 已连接的网站（含各自的机器令牌）和 `localPolicy`。权限 0600；如果权限更宽松，守护进程会收紧它。 |
| `~/.uncage/sites/<site id>/data` | 该网站会话的本地数据库（以此为准） |
| `~/.uncage/sites/<site id>/activity.log` | 该网站在这台电脑上做过的事（JSON lines） |
| `~/Uncage/<site host>/<session id>/` | 每个会话一个目录；Claude Code 在这里工作 |
| `~/.uncage/logs/agent.log`、`agent.err.log` | 后台守护进程的输出 |
| `~/Library/LaunchAgents/dev.uncage.agent.plist` | macOS：让守护进程保持运行的 launchd 服务 |
| `~/.config/systemd/user/uncage-agent.service` | Linux：systemd 用户服务 |
| 计划任务 `UncageAgent` | Windows：计划任务（任务计划程序拒绝时，改为 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `UncageAgent` 项） |

`UNCAGE_HOME=/absolute/path` 可以在开发和测试时迁移 `~/.uncage` 和 `~/Uncage`（后台服务不能使用它：先运行 `uncage setup <url> --no-daemon`，再带着同一个变量在前台运行 `uncage agent`）。`HOME` 不变，所以 Claude Code 的登录状态保持不变。

## `~/.uncage/agent.yaml`

由 `uncage setup` 创建和更新。一个典型的文件：

```yaml
# Uncage agent config. Holds machine tokens: keep it private (0600).
# localPolicy.allowBypass: true lets websites use bypassPermissions (only you can turn it on).
# localPolicy.allowedPermissionModes: optional list capping the modes websites may use.
sites:
  - id: app.example.com
    name: Example App
    url: https://app.example.com/api/uncage
    machineId: mch_3f9c…
    token: …            # secret: never share it
    machineKey: …
localPolicy:
  allowBypass: false
```

只有 `localPolicy` 和 `runtimes` 是供手动编辑的。`uncage setup` 或 `uncage sites remove` 重写 `sites` 列表时，你的注释、`localPolicy` 和 `runtimes` 会被保留。未知的键会被拒绝，错误信息里会写出它们的名称。

### `localPolicy.allowBypass`

默认 `false`。`bypassPermissions` 让 Claude Code **不经询问**执行任何命令、修改任何文件。网站可以在界面里提供这个模式，但除非这里是 `true`，守护进程都会以 `policy_denied` 拒绝它（“bypassPermissions can only be enabled on this computer (localPolicy.allowBypass in ~/.uncage/agent.yaml)”）。任何网站设置都改变不了这一点。

```yaml
localPolicy:
  allowBypass: true
```

开启后，守护进程会在启动时记录一条警告。标记了 `requiresConfirmation` 的工具即使在绕过权限模式下也仍会询问。

### `localPolicy.allowedPermissionModes`

可选，限制**任何**网站在这台电脑上能使用的模式。改用其他模式的设置变更，或以其他模式启动的运行，都会以 `policy_denied` 被拒绝（“Permission mode "…" is not allowed on this computer (localPolicy.allowedPermissionModes)”）。

```yaml
localPolicy:
  allowBypass: false
  allowedPermissionModes: [default, plan]   # ask for everything, or plan only
```

模式：`default`、`acceptEdits`、`plan`、`auto`、`bypassPermissions`（最后一个还需要 `allowBypass: true`）。新会话从 `default` 开始，所以请把 `default` 留在列表里，除非你希望在用户选中允许的模式之前，每次运行都被拒绝。

### `runtimes.acp`

这台电脑在 Claude Code 和 Codex 之外还提供哪些 agent：Gemini CLI、OpenCode、Claude Code 的 ACP 适配器，或任何支持 Agent Client Protocol 的 agent。ACP registry 里需要下载代码的 agent（`npx`、`uvx`）只有在执行 `uncage runtimes enable <id>` 之后才会运行；`uncage runtimes` 会列出提供了哪些运行时。详见[使用任意 ACP agent](/docs/zh-cn/guides/use-any-acp-agent/)。

### 让修改生效

守护进程在启动时读取 `agent.yaml`。编辑后请重启它：

```sh
launchctl kickstart -k gui/$(id -u)/dev.uncage.agent    # the background service
```

如果你是在前台运行 `uncage agent`，就停掉再启动它。

## 活动日志

网站发来的每条命令、每次网站工具调用、每次文件拉取和每次审批，连同连接、断开、吊销和升级，都会追加到 `~/.uncage/sites/<site id>/activity.log`。

```sh
uncage activity                       # every website
uncage activity --site app.example.com --follow
uncage activity --json                # one JSON object per line
```

日志经过脱敏：保留 id、状态和错误码；不记录提示词、文件内容和工具参数。

## 网站

```sh
uncage sites                          # ID, NAME, HOST, MACHINE, STATUS
uncage sites remove app.example.com   # disconnect
```

`uncage sites remove` 会（用电脑自己的令牌）在网站上吊销这台电脑，从 `agent.yaml` 里删除令牌，并重启后台守护进程。本地的会话数据和工作区会保留。如果网站无法访问，令牌照样会被删除，网站一侧仍可以吊销这台电脑。

如果网站吊销了这台电脑，守护进程会在 `agent.yaml` 里把该网站标记为 `revoked`，并停止连接它。再次运行 `uncage setup <url>` 即可重新连接。（对一个电脑仍在连接的网站运行 `uncage setup` 会重新配对：电脑保留原来的 machine id 和会话，并获得一枚新令牌。）

## 后台守护进程

- `uncage setup <url>`（或 `uncage agent install`）把它安装成按用户运行的后台服务，固定使用运行这条命令的 Node.js。不需要管理员权限。
  - **macOS：** launchd 用户级服务（LaunchAgent）。登录时启动，崩溃或自我升级后由 launchd 重启（正常退出后不会重启，例如没有剩余网站时）。
  - **Linux：** systemd 用户服务（`Restart=on-failure`）。除非开启了驻留（linger），注销时会停止：`loginctl enable-linger $USER`。没有用户级 systemd 时，请在前台运行 `uncage agent`。
  - **Windows：** 登录时启动的计划任务，只针对当前用户、最低权限；无法创建计划任务时改用注册表的 Run 项。一个小的监督进程会在守护进程崩溃或自我升级后将其重启。
- `uncage agent status` 显示服务、是否在运行以及它使用的 Node.js。如果那个 Node.js 被删除了（Homebrew 升级、删除了 nvm 或 fnm 的某个版本），请重新运行 `uncage agent install`。
- `uncage agent uninstall` 停止它并移除服务。`agent.yaml` 和数据会保留。
- `uncage agent` 在前台运行它（先停掉服务）。设置 `UNCAGE_LOG_LEVEL=debug` 可以输出更多信息。
- 升级：如果某个 hub 要求更新的守护进程（`upgrade_required`），守护进程会运行一次 `npm i -g @uncage/cli@latest`，然后重启。
- 一个守护进程服务所有已连接的网站，每个网站有各自的连接、数据库和目录。Local 模式（`uncage serve`）可以同时在同一台电脑上运行。

## 本地扩展

可执行的扩展（例如在运行完成时部署项目的 hook）只能来自**这台电脑**：用户自己安装的 npm 包，或用户自己编写的本地配置。网站只能发送数据（工具 schema、技能文本和模板），绝不能发送在这里运行的代码。Uncage 0.3 还没有提供本地扩展 API；目前 `localPolicy` 就是本地的控制面。
