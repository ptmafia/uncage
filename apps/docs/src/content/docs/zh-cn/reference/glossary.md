---
title: 术语表
description: Uncage 每个术语的一句话定义（守护进程、电脑、hub、网站工具、技能、清单、文件通道、网站侧存储、集群、权限模式、Local 模式和 Connected 模式），附准确的 API 名称和中文界面用词。
---

本站、界面和 API 里的这些词，在任何地方含义都相同。**界面用词**一栏是终端用户在 `@uncage/react-ui` 里看到的文字（English / 简体中文）。

| 术语 | 定义 | API 名称 | 界面用词 |
| --- | --- | --- | --- |
| **Connected 模式**（Connected Mode） | 网站通过 hub 指挥每个用户自己电脑上的 Claude Code。 | `@uncage/hub`、`@uncage/agent` | |
| **Local 模式**（Local Mode） | 应用通过本地的 Uncage 服务和同源代理，指挥它所在机器上的 Claude Code。 | `uncage serve`、`createUncageHandler` | |
| **网站**（website / site） | 你的 Web 应用。它运行一个 hub。电脑通过站点 id 和名称识别它。 | `HubOptions.site`、`publicUrl` | site / 网站 |
| **hub** | 挂在你网站 Node 后端里的那部分 Uncage：设备登录、电脑连接、浏览器 API、网站工具。 | `createHub()`、`Hub` | |
| **基础路径**（base path） | hub 挂载的位置。 | `basePath`，默认 `/api/uncage` | |
| **电脑**（computer / machine） | 某个用户连接到你网站的一台电脑。API 里叫 machine，界面里叫 computer（电脑）。 | `MachineInfo`、`machineId`、`useMachines()` | computer / 电脑 |
| **守护进程**（agent） | 用户电脑上的后台进程，负责连接 hub 并运行 Claude Code。 | `uncage agent`、`@uncage/agent` | the agent / 守护进程 |
| **在线**（online） | 电脑的 WebSocket 已连接并响应心跳。失去响应后约 30 秒内变为离线。 | `MachineInfo.online` | online / 在线, offline / 离线 |
| **配对 / 设备登录**（pairing / device login） | 把一台电脑关联到一个用户：`uncage setup` 拿到一个码，用户在 `/device` 上批准它。 | `approveDevice`、`lookupDevice`、`denyDevice` | |
| **用户码**（user code） | 用户核对并批准的 8 位码（`ABCD-EFGH`），10 分钟内有效。 | `?code=` | |
| **审批页**（approval page） | 你网站上的 `/device` 页面，已登录用户在这里批准一个码。 | `verificationPath`、`<ApproveDevice>` | |
| **机器令牌**（machine token） | 电脑连接某个网站时使用的密钥，只保存在 `~/.uncage/agent.yaml` 里。 | | |
| **吊销**（revoke） | 把一台电脑从网站上永久断开；它的令牌随即失效。 | `revokeMachine`、`uncage sites remove` | |
| **运行时**（runtime） | 实际干活的 coding agent：Claude Code（`claude`）或 Codex（`codex`）。 | `RuntimeInfo`、`RuntimeAdapter` | |
| **会话**（session） | 一段对话：一个运行时，在一台电脑上。 | `Session`、`sessionId` | session / 会话 |
| **工作区**（workspace） | 会话工作所在的目录。Connected 模式下为 `~/Uncage/<站点主机名>/<会话 id>/`。 | `Session.workspace` | |
| **运行**（run） | 一条提示词，以及 agent 为回答它所做的一切。 | `Run`、`runId`、`RunState` | |
| **事件**（event） | 会话里发生的一件带序号的事，通过 SSE 推送。 | `UncageEvent`、`sequence` | |
| **序号**（sequence） | 会话内的事件编号；断线续传和复制都依赖它。 | `UncageEvent.sequence`、`Last-Event-ID` | |
| **审批**（approval） | 请用户允许或拒绝某个操作的请求。 | `ApprovalRequest`、`useApprovals()` | Allow once / Deny, 允许执行 / 拒绝 |
| **权限模式**（permission mode） | 哪些操作需要审批：`default`、`acceptEdits`、`plan`、`auto`、`bypassPermissions`。 | `PermissionMode`、`useSessionSettings()` | |
| **绕过权限**（bypass permissions） | 不需要任何审批的模式。只有用户本人能在自己的电脑上允许它。 | `localPolicy.allowBypass` | |
| **网站工具**（site tool） | 你网站上一项 Claude Code 可以调用的能力；handler 以该用户身份在你的服务器上运行。 | `defineTool()`、`SiteTool`、`ToolContext` | |
| **确认**（confirmation） | 每次调用前都先询问用户的网站工具。 | `requiresConfirmation: true` | |
| **技能**（skill） | Markdown 说明加上可选的模板文件，Claude Code 在相关时加载。 | `SkillSpec`、`skills` | |
| **清单**（manifest） | 提供给某一次运行的工具和技能。 | `selectManifest()`、`SessionManifest` | |
| **文件通道**（file channel） | 工具 handler 从电脑上这次运行的工作区读取文件的方式。 | `ctx.files.pull()`、`ctx.files.read()` | |
| **网站侧存储**（site storage） | hub 保存每段对话的副本，电脑关机时也能查看。 | `sessionStorage: 'site'` | |
| **hub 存储**（hub store） | hub 的数据库：电脑、会话索引、工具调用审计、对话副本。 | `HubStore`、`pgliteHubStore`、`postgresHubStore` | |
| **节点**（node） | 一个 hub 进程。多个节点共享一个存储和一个集群适配器。 | | |
| **集群适配器**（cluster adapter） | 在 hub 节点之间共享在线信息并传递消息。 | `ClusterAdapter`、`memoryCluster`、`redisCluster` | |
| **本地策略**（local policy） | 用户在自己电脑上为所有网站设定的限制。 | `~/.uncage/agent.yaml` 里的 `localPolicy` | |
| **活动日志**（activity log） | 网站在一台电脑上所做一切的本地记录。 | `uncage activity` | |
| **Uncage 服务**（daemon） | Local 模式的服务器 `uncage serve`，监听 `127.0.0.1:4783`。 | `@uncage/server` | |
| **代理**（proxy） | Local 模式下你应用里的同源路由，带着 Uncage 服务的令牌把请求转发给它。 | `createUncageHandler`、`createUncageNodeHandler` | |
| **草稿**（draft） | 界面里尚未发出第一条提示词的待建会话，保存着设置和文件。 | `openDraft()`、`commitDraft()`、`isDraft` | |
