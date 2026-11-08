---
title: 使用任意 ACP agent
description: 在 Claude Code 和 Codex 之外，再提供 Gemini CLI、OpenCode、Claude Code 的 ACP 适配器或任何其他 Agent Client Protocol agent：~/.uncage/agent.yaml 中的 runtimes.acp、预设、ACP registry、与原生运行时的差异、故障排查和检查清单。
---

[Agent Client Protocol](https://agentclientprotocol.com)（ACP）是客户端（编辑器，在这里是 Uncage）与编程 agent 之间的开放协议。客户端把 agent 作为本地进程启动，通过 stdin/stdout 与它交换 JSON-RPC 消息：创建会话、发送提示词，并接收流式的消息、工具调用、计划和权限请求。很多 agent 都支持它：Gemini CLI、OpenCode、通过 ACP 适配器接入的 Claude Code，以及 [ACP registry](https://github.com/agentclientprotocol/registry) 里的几十个其他 agent。

`@uncage/runtime-acp` 把每一个这样的 agent 变成一个 Uncage 运行时。它们出现在网站的运行时选择器里，名称为 `<name> (ACP)`，运行时 id 为 `acp-<id>`，与原生的 Claude Code 和 Codex 运行时并列。agent 在用户的电脑上、在会话目录里运行，使用它自己的登录状态：Uncage 永远看不到它的凭据。

和[本地策略](/docs/zh-cn/guides/local-policy/)一样，这一页讲的是**用户一侧**（运行 `uncage agent` 的那台电脑）。网站不需要任何改动：新的运行时和其他运行时一样经由 hub 到达网站。

## 配置

ACP agent 在 `~/.uncage/agent.yaml` 的 `runtimes.acp` 里配置。完全没有 `runtimes` 键时使用默认值：命令在 PATH 上的预设会被注册，ACP registry 里已安装的 agent 会被检测出来。下面是包含所有字段的完整示例：

```yaml
runtimes:
  acp:
    presets: auto        # auto: register the presets whose command is on PATH; off: only what is listed below
    autoDetect: true     # detect installed agents from the ACP registry (handshake-checked); false: no detection
    enable: [gemini]     # registry agents you consented to run (written by `uncage runtimes enable`)
    consented:           # exactly what each `enable` consented to run (written by `uncage runtimes enable`)
      gemini:
        runner: npx
        package: "@google/gemini-cli"
        args: [--acp]
        env: {}
    disable: [opencode]  # registry, preset or runtime ids that are never registered
    agents:
      - id: claude                    # runtime id acp-claude
        preset: claude                # fill in the preset's name, command and install hint
      - id: mine                      # runtime id acp-mine
        displayName: My Agent         # shown in the runtime picker (default: the preset's name, else the id)
        command: [/usr/local/bin/my-agent, --acp]   # argv; command[0] is an absolute path or found on PATH
        env:                          # added to the agent's environment
          MY_AGENT_LOG: warn
        mcp: auto                     # site tools: auto (http if the agent supports it, else stdio), http, stdio, off
        enabled: true                 # false keeps the entry but does not register it
```

| 字段 | 默认值 | |
| --- | --- | --- |
| `presets` | `auto` | `auto` 注册命令在 PATH 上、且没有在 `agents` 里列出的每个[预设](#预设)。`off`：一个都不注册。 |
| `autoDetect` | `true` | 从 ACP registry 检测已安装的 agent。只有回应了 ACP `initialize` 握手的 agent 才会启用（按路径和文件版本缓存）。`false`：不检测，也不握手。 |
| `enable` | `[]` | 即使没有检测到也要运行的 registry agent，例如通过 `npx` 或 `uvx` 下载的 agent。请用 `uncage runtimes enable <id>`，不要手动编辑。 |
| `consented` | `{}` | `enable` 里每个 id 对应你同意运行的内容：运行方式（`local`、`npx`、`uvx`）、命令或包（任意版本）、`args` 和 `env`。如果 registry 之后改成运行别的东西，这个 agent 会等你再次执行 `uncage runtimes enable`。 |
| `disable` | `[]` | 无论其他设置怎么写，都不注册这些（`uncage runtimes disable <id>`）。 |
| `agents` | `[]` | 你自己列出的 agent。只要 `enabled`，总会注册。 |
| `agents[].id` | 必填 | 小写字母、数字和 `-`。运行时 id 为 `acp-<id>`。不能重复。 |
| `agents[].preset` | | `claude`、`gemini` 或 `opencode`。每一项需要 `preset` 或 `command`；条目自己的字段优先。 |
| `agents[].displayName` | 预设的名称，否则为 id | 最多 60 个字符。 |
| `agents[].command` | 预设的命令 | argv，不经过 shell。 |
| `agents[].env` | | 额外的环境变量。 |
| `agents[].mcp` | `auto` | [网站工具](/docs/zh-cn/guides/define-tools/)如何到达 agent；`off` 为这个 agent 关闭网站工具。 |
| `agents[].enabled` | `true` | |

守护进程在启动时读取 `agent.yaml`：修改后请重启它（见[让修改生效](/docs/zh-cn/guides/local-policy/#让修改生效)）。`uncage setup` 和 `uncage sites remove` 会保留 `runtimes` 和你的注释。

要查看这台电脑提供哪些运行时，运行 `uncage runtimes`：

```text
ID          NAME               STATUS         VERSION  SITE TOOLS  RESUME
claude      Claude Code        available      2.1.318  yes         yes
codex       Codex              not installed  -        no          yes
acp-claude  Claude Code (ACP)  available      0.101.0  yes         yes
```

它还会列出尚未注册的 registry agent，以及如何开启它们。`--json` 以 JSON 输出同样的内容，`--all` 额外列出没有安装的 registry agent，`--refresh` 会先下载最新的 registry。

### 来自 ACP registry 的 agent

Uncage 自带一份官方 ACP registry 的快照（名称、命令、图标）；守护进程每天最多在后台刷新一次（`UNCAGE_ACP_REGISTRY_REFRESH=0` 可以关闭）。registry 里的任何东西都要经过检查才会运行：

- 这台电脑上已安装的 agent（适用于本系统的二进制文件，或 PATH 上已知的 npm bin）只有在回应了 ACP 握手后才会启用。registry 刷新后，命令发生变化的 agent 会等待 `uncage runtimes enable`。
- 通过 `npx` 或 `uvx` 分发的 agent 会下载代码，所以在你运行 `uncage runtimes enable <id>` 之前绝不会运行。这条命令会把你同意的内容记录到 `consented`。

```sh
uncage runtimes enable gemini    # consent: prints exactly what will run, then registers it
uncage runtimes disable gemini   # never register it
```

在 Local 模式（`uncage serve`）中，`uncage.config.yaml` 接受同样的 `runtimes.acp` 配置块，只是其中的 `enable` 和 `consented` 会被忽略：项目文件不能代替用户同意运行下载的 agent。`uncage doctor` 和 `uncage serve` 会打印项目文件添加的每个 ACP agent 的命令。

## 预设

| 预设 | 运行时 | 命令 | 安装 | 状态 |
| --- | --- | --- | --- | --- |
| `claude` | Claude Code (ACP) | `claude-agent-acp` | `npm i -g @agentclientprotocol/claude-agent-acp`（使用你的 Claude Code 登录状态） | **已实机验证**，版本 `@agentclientprotocol/claude-agent-acp` 0.101.0（2026-11-08）：流式输出、审批、网站工具、恢复会话、停止 |
| `gemini` | Gemini CLI (ACP) | `gemini --acp` | `npm i -g @google/gemini-cli` | 协议兼容，未实机验证 |
| `opencode` | OpenCode (ACP) | `opencode acp` | `npm i -g opencode-ai` | 协议兼容，未实机验证 |

这些命令与 ACP registry 中的条目一致。运行 Claude Code 仍推荐使用原生 Claude Code 运行时（它支持模型、推理强度、`plan` 和 `auto`）；`claude` 预设适合用来对比，或在只能使用 ACP 适配器的场合使用。最新结果见[兼容性矩阵](https://github.com/ptmafia/uncage/blob/main/docs/compatibility.md)。

## 与原生运行时的差异

| | 原生 Claude Code | ACP agent |
| --- | --- | --- |
| 技能 | 作为 Claude Code 技能安装（`.claude/skills/`） | ACP 没有技能：写入会话目录下的 `.uncage/skills/<name>/`，每个新会话的第一条提示词会以文本形式列出这些技能和路径（`skills: 'prompt'`） |
| 文件和命令 | Claude Code 自己的工具 | agent 在会话目录里使用自己的工具。Uncage 不提供 ACP 的 `fs` 或 `terminal` 客户端能力 |
| 审批 | 允许执行 / 拒绝 | 允许执行 / 拒绝。Uncage 用 agent 提供的 `allow_once` 或 `reject_once` 选项作答，从不选择“始终”类选项（agent 可能把它保存到会话之外） |
| 权限模式 | `default`、`acceptEdits`、`plan`、`auto`、`bypassPermissions` | `default`、`acceptEdits`，以及仅在 `localPolicy.allowBypass` 开启时可用的 `bypassPermissions`。Uncage 自己执行这些模式，如果 agent 有同名模式，也会把 agent 切换过去 |
| 模型和推理强度 | 来自 Claude Code | 不提供（使用 agent 自己的默认值） |
| 思考过程、用量、斜杠命令 | 不显示思考过程 | 不显示 |
| 计划 | — | 一个“Plan”步骤，输出为清单 |
| 网站工具 | 进程内 MCP server | 每次运行一个回环地址上的 MCP server，带一次性 bearer token，以 `site` 的名称放进 `mcpServers` 交给 agent（agent 支持时走 HTTP，否则经由一个小型 stdio 桥）。带 `requiresConfirmation` 的工具每次调用前都会在 Uncage 里请求确认 |
| 恢复会话 | 总是可以 | 仅当 agent 支持 `session/resume` 或 `session/load` 时。否则下一条消息会开始新的对话，并带有 `acp_resume_unsupported` 警告 |
| 附件 | 图片和文件 | agent 接受图片时发送图片；其他文件以指向其路径的链接发送 |

每个运行时在第一次使用时启动一个 agent 进程，由所有会话共享；进程退出后会重新启动。停止时会发送 `session/cancel`，如果 agent 在 10 秒内没有停下，就结束它的进程组。

## 故障排查

| 现象 | 怎么做 |
| --- | --- |
| 运行时显示 `not_installed`（“未安装”） | 命令不在 PATH 上。安装 agent（提示里写了方法），或在 `command` 里写绝对路径，然后重启守护进程。 |
| 运行失败，错误为 `auth_required` | agent 需要它自己的登录。在终端里用 agent 本身登录（例如运行 `claude` 后输入 `/login`，或运行 `gemini`），然后重试。Uncage 从不经手 agent 的凭据。 |
| “The agent did not answer initialize within 15000 ms” | 命令启动了，但不支持 ACP（参数不对、版本太旧，或者在等待输入）。手动运行这条命令：它应该静静地等待 stdin 上的 JSON。 |
| registry agent 显示为 `available`，但没有注册 | 它通过 `npx`/`uvx` 分发，或者 registry 刷新后命令变了。如果需要，运行 `uncage runtimes enable <id>`。 |
| 运行时不见了 | 查看 `uncage runtimes`（以及 `uncage runtimes --all`）：它可能被禁用了、设置了 `enabled: false`，或者 `presets: off`。`uncage doctor` 为每个 ACP agent 显示一行 `runtime.acp-<id>`；这些行不会让检查失败。 |
| 网站工具没有被调用 | 这个 agent 设置了 `mcp: off`，或者 agent 不支持 MCP server。可以设置 `mcp: stdio` 试试 stdio 桥。 |
| 切换模式时运行失败，错误为 `policy_denied` | agent 无法切换到网站的权限模式，会停留在更宽松的模式。 |

## 验证

1. `uncage runtimes` 把这个 agent 列为 `available`，显示版本号；除非设置了 `mcp: off`，`SITE TOOLS` 为 `yes`。
2. `uncage doctor` 显示 `✓ Runtime acp-<id>`。
3. 在网站上，运行时选择器列出 `<name> (ACP)`；选中它并发送一条提示词：回答会流式显示。
4. 在 `default` 模式下要求修改文件：出现审批卡片；点击**允许执行**后才会修改。
5. 让它使用一个需要确认的网站工具：恰好出现一张审批卡片，允许后工具在网站上运行。
6. 在同一个会话里继续提问：agent 记得之前的对话（`RESUME` 为 `yes` 时）。
7. 启动一个耗时的命令，然后点击停止：运行会在几秒内取消。
