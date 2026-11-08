---
title: Uncage
description: 让你的网站指挥用户自己电脑上的 Claude Code。任务在用户自己的电脑上执行，对话、审批和产出都留在你的网站上。
template: splash
hero:
  tagline: 网站下达指令，用户自己电脑上的 Claude Code 动手干活，并调用你网站的工具。过程和产出都留在你的网站上。
  actions:
    - text: Connected 模式快速上手
      link: /docs/zh-cn/start/quickstart-connected/
      icon: right-arrow
    - text: 工作原理
      link: /docs/zh-cn/start/how-it-works/
      variant: minimal
    - text: 面向 coding agent
      link: /docs/zh-cn/start/for-coding-agents/
      variant: minimal
---

## Uncage 是什么

Uncage 是一组 npm 包，把 Claude Code（以及 Codex）接入你自己的网页界面，自带审批、流式输出、停止和刷新不丢的历史。

它有两种模式，共用同一套协议、同一套 React hooks 和同一个 `<AgentChat>` 界面。

| | **Connected 模式**（0.2 新增） | **Local 模式** |
| --- | --- | --- |
| 谁在跑 agent | 每个终端用户，在自己的电脑上，用自己的 Claude Code 登录 | 你自己，在运行应用的那台机器上 |
| 网站要加什么 | Node 后端里挂上 `@uncage/hub`，页面里放 `<AgentChat>`，再加一个 `/device` 审批页 | 一个同源代理路由和 `<AgentChat>` |
| 用户要做什么 | 运行一次一条命令，再在浏览器里批准这台电脑：macOS 和 Linux 上是 `curl -fsSL https://your.site/api/uncage/install.sh \| bash`，Windows 上是 `irm https://your.site/api/uncage/install.ps1 \| iex` | 什么都不用做：就是你自己的机器 |
| 适合 | 用户装有 Claude Code、希望它和你的产品一起干活的 SaaS | 内部工具、桌面类应用、开发者面板 |

## 你的用户得到什么

- 你网站上的一个对话框，指挥的是**他们自己的** Claude Code。除了你自己的代码，你的服务器上什么都不跑。
- 回答和每一个工具步骤都实时流式显示。
- 执行命令、修改文件，以及调用你那些需要确认的工具时，弹出 **允许执行 / 拒绝** 卡片。
- 停止、附件、模型 / 推理强度 / 权限模式选择，刷新页面历史不丢。
- 开启网站侧存储后，即使用户电脑关机，对话在你的网站上依然可以查看。

## 你作为网站得到什么

- **网站工具（site tools）。** 用 `defineTool` 声明一个能力（名称、zod schema、handler）。Claude Code 把它当作一个 MCP 工具。handler **在你的后端运行，身份是当前登录用户**，还能从这次运行的工作区拉取文件（`ctx.files.pull`）。
- **技能（skills）。** 用纯 Markdown 把你的规范和模板交给 Claude Code，它会像加载普通 Claude Code 技能一样加载。
- **按次选择。** `selectManifest` 根据提示词和用户，为每次运行挑选工具和技能。
- **你的登录、你的存储、你的规模。** `getUser(req)` 接入你现有的登录体系。Postgres 和 Redis 适配器让 hub 可以在负载均衡后面跑多个节点。

## Uncage 永远不会做的事

- 从你的网站向用户电脑发送代码或 shell 命令。hub 只发送数据：工具的名称和 schema、技能文本，以及一组固定的命令（比如“开始一次运行”）。
- 让多个用户共用一个 Claude 登录。每台电脑用的都是主人自己的 Claude Code。
- 让网站打开绕过权限（`bypassPermissions`，界面中显示为“完全放行”）。只有用户本人能在自己电脑上的配置文件里打开。

完整列表见[信任模型](/docs/zh-cn/concepts/trust-model/)。

## 从哪里开始

- **在做网站？** 先读[工作原理](/docs/zh-cn/start/how-it-works/)，再做 [Connected 模式快速上手](/docs/zh-cn/start/quickstart-connected/)（约 15 分钟）。
- **agent 和你的应用在同一台机器上？** [Local 模式快速上手](/docs/zh-cn/start/quickstart-local/)只要 5 分钟。
- **在用 coding agent？** 把 [Uncage 技能](/docs/skills/uncage/SKILL.md) 或 [`llms.txt`](/docs/llms.txt) 交给它。每个页面都有纯 Markdown 版本：在网址后面加 `.md` 即可。详见[面向 coding agent](/docs/zh-cn/start/for-coding-agents/)。

:::note[状态]
Connected 模式属于 Uncage 0.2（`@uncage/hub`、`@uncage/agent`，以及 `@uncage/cli` 里的 `uncage setup` / `uncage agent` 命令）。用户电脑一侧支持 **macOS、Linux 和 Windows**，以按用户运行的后台服务运行，需要 Node.js 22 或更高版本（安装脚本会帮你装好）。macOS 已在真机上验证；Linux 和 Windows 已通过 CI 验证，尚待真机确认。Claude Code 已实机验证；Codex 已实现，但还没有对真实二进制运行过，也暂不支持网站工具。详见[兼容性记录](https://github.com/ptmafia/uncage/blob/main/docs/compatibility.md)。
:::
