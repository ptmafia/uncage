---
title: Glossary
description: One-line definitions of every Uncage term (agent, computer, hub, site tool, skill, manifest, file channel, site storage, cluster, permission mode, Local and Connected Mode), with the exact API names and the Chinese UI words.
---

The words on this site, in the UI and in the API mean the same thing everywhere. The **UI words** column is what end users see in `@uncage/react-ui` (English / 简体中文).

| Term | Definition | API name | UI words |
| --- | --- | --- | --- |
| **Connected Mode** | A website drives Claude Code on each user’s own computer through a hub. | `@uncage/hub`, `@uncage/agent` | |
| **Local Mode** | An app drives Claude Code on the machine it runs on, through a local daemon and a same-origin proxy. | `uncage serve`, `createUncageHandler` | |
| **Website / site** | Your web application. It runs one hub. Computers know it by a site id and name. | `HubOptions.site`, `publicUrl` | site / 网站 |
| **Hub** | The part of Uncage mounted in your website’s Node backend: device login, computer connections, browser API, site tools. | `createHub()`, `Hub` | |
| **Base path** | Where the hub is mounted. | `basePath`, default `/api/uncage` | |
| **Computer / machine** | One user’s computer connected to your website. “Machine” in the API, “computer” in the UI. | `MachineInfo`, `machineId`, `useMachines()` | computer / 电脑 |
| **Agent** | The background process on the user’s computer that connects to hubs and runs Claude Code. | `uncage agent`, `@uncage/agent` | the agent / 守护进程 |
| **Online** | The computer’s WebSocket is connected and answering heartbeats. Offline within about 30 s of going silent. | `MachineInfo.online` | online / 在线, offline / 离线 |
| **Pairing / device login** | Linking a computer to a user: `uncage setup` gets a code, the user approves it on `/device`. | `approveDevice`, `lookupDevice`, `denyDevice` | |
| **User code** | The 8-character code (`ABCD-EFGH`) the user compares and approves. Valid 10 minutes. | `?code=` | |
| **Approval page** | Your page at `/device` where a signed-in user approves a code. | `verificationPath`, `<ApproveDevice>` | |
| **Machine token** | The secret a computer uses to connect to one website. Stored only in `~/.uncage/agent.yaml`. | | |
| **Revoke** | Disconnect a computer from a website for good; its token stops working. | `revokeMachine`, `uncage sites remove` | |
| **Runtime** | The coding agent that does the work: Claude Code (`claude`) or Codex (`codex`). | `RuntimeInfo`, `RuntimeAdapter` | |
| **Session** | One conversation with one runtime on one computer. | `Session`, `sessionId` | session / 会话 |
| **Workspace** | The folder a session works in. Connected Mode: `~/Uncage/<site host>/<session id>/`. | `Session.workspace` | |
| **Run** | One prompt and everything the agent does to answer it. | `Run`, `runId`, `RunState` | |
| **Event** | One numbered thing that happened in a session, streamed over SSE. | `UncageEvent`, `sequence` | |
| **Sequence** | The per-session event number; resuming and replication use it. | `UncageEvent.sequence`, `Last-Event-ID` | |
| **Approval** | A request for the user to allow or deny an action. | `ApprovalRequest`, `useApprovals()` | Allow once / Deny, 允许执行 / 拒绝 |
| **Permission mode** | How much needs approval: `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`. | `PermissionMode`, `useSessionSettings()` | |
| **Bypass permissions** | The mode with no approvals. Only the user can allow it, on their own computer. | `localPolicy.allowBypass` | |
| **Site tool** | A capability of your website that Claude Code can call; the handler runs on your server as the user. | `defineTool()`, `SiteTool`, `ToolContext` | |
| **Confirmation** | A site tool that asks the user before every call. | `requiresConfirmation: true` | |
| **Skill** | Markdown instructions plus optional template files that Claude Code loads when relevant. | `SkillSpec`, `skills` | |
| **Manifest** | The tools and skills offered to one run. | `selectManifest()`, `SessionManifest` | |
| **File channel** | How a tool handler reads files from the run’s workspace on the computer. | `ctx.files.pull()`, `ctx.files.read()` | |
| **Site storage** | The hub keeps a replica of every conversation, readable while the computer is off. | `sessionStorage: 'site'` | |
| **Hub store** | The hub’s database: computers, session index, tool-call audit, replicas. | `HubStore`, `pgliteHubStore`, `postgresHubStore` | |
| **Node** | One hub process. Several nodes share a store and a cluster adapter. | | |
| **Cluster adapter** | Shares presence and carries messages between hub nodes. | `ClusterAdapter`, `memoryCluster`, `redisCluster` | |
| **Local policy** | Limits the user sets on their own computer for every website. | `localPolicy` in `~/.uncage/agent.yaml` | |
| **Activity log** | The local record of everything websites did on a computer. | `uncage activity` | |
| **Daemon** | Local Mode’s server, `uncage serve`, on `127.0.0.1:4783`. | `@uncage/server` | |
| **Proxy** | Local Mode’s same-origin route in your app that forwards to the daemon with its token. | `createUncageHandler`, `createUncageNodeHandler` | |
| **Draft** | A session-to-be in the UI, before the first prompt, holding settings and files. | `openDraft()`, `commitDraft()`, `isDraft` | |
