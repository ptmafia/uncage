---
title: Glossary
description: One-line definitions of every Uncage term (agent, computer, hub, deployment mode, transport, site tool, skill, manifest, file channel, site storage, cluster, permission mode, Local and Connected Mode), with the exact API names and the Chinese UI words.
---

The words on this site, in the UI and in the API mean the same thing everywhere. The **UI words** column is what end users see in `@uncage/react-ui` (English / 简体中文).

| Term | Definition | API name | UI words |
| --- | --- | --- | --- |
| **Connected Mode** | A website drives Claude Code on each user’s own computer through a hub. | `@uncage/hub`, `@uncage/agent` | |
| **Local Mode** | An app drives Claude Code on the machine it runs on, through a local daemon and a same-origin proxy. | `uncage serve`, `createUncageHandler` | |
| **Website / site** | Your web application. It runs one hub. Computers know it by a site id and name. | `HubOptions.site`, `publicUrl` | site / 网站 |
| **Hub** | The part of Uncage mounted in your website’s backend: device login, computer connections, browser API, site tools. A Fetch handler. | `createHub()`, `Hub`, `hub.fetch()` | |
| **Deployment mode** | Where and how the hub runs: traditional mode or FaaS mode. | | |
| **Traditional mode** | The hub in a long-running Node process: embedded store, WebSocket, no external dependency. | `@uncage/hub/node`: `toNodeHandler`, `attachWebSocket`, `pgliteHubStore` | |
| **FaaS mode** | The hub in serverless functions or on a Fetch platform (Vercel, Cloudflare Workers): Postgres, HTTP streaming. | `toNextHandlers`, `fetchOnce`, `postgresHubStore`, `postgresCluster` | |
| **Function instance** | One running copy of a serverless function. In FaaS mode every instance is a hub node. | | |
| **Transport** | How a computer is linked to the hub: WebSocket (`ws`) or HTTP streaming (`http`). The hub offers, the agent chooses. | `TransportKind`, `transports`, `GET /agent/info` | |
| **HTTP streaming** | The `http` transport: a long `GET /agent/stream` downstream (rotated before the platform limit) and `POST /agent/events` upstream. | `stream.maxDurationMs`, `polling` | |
| **Outbox** | The durable, numbered queue of commands for one computer, in the hub’s store. The agent resumes from its cursor. | `OutboxItem`, `cursor`, `ack` | |
| **Maintenance** | The hub’s periodic cleanup (retention, failing calls of dead instances), at most once per interval across instances. | `maintenance`, `hub.maintain()`, `/maintenance` | |
| **Base path** | Where the hub is mounted. | `basePath`, default `/api/uncage` | |
| **Computer / machine** | One user’s computer connected to your website. “Machine” in the API, “computer” in the UI. | `MachineInfo`, `machineId`, `useMachines()` | computer / 电脑 |
| **Agent** | The background process on the user’s computer that connects to hubs and runs Claude Code. | `uncage agent`, `@uncage/agent` | the agent / 守护进程 |
| **Online** | The computer’s connection is live (a WebSocket answering heartbeats, or an open HTTP stream). Offline within about 30 s of going silent. | `MachineInfo.online`, `MachineInfo.transport` | online / 在线, offline / 离线 |
| **Agent update needed** | The computer’s agent is older than the hub’s `minAgentVersion`. | `MachineInfo.agentOutdated`, `upgrade_required` | Agent update needed / 需要更新守护进程 |
| **Pairing / device login** | Linking a computer to a user: `uncage setup` gets a code, the user approves it on `/device`. | `approveDevice`, `lookupDevice`, `denyDevice` | |
| **User code** | The 8-character code (`ABCD-2345`) the user compares and approves. Valid 10 minutes. | `?code=` | |
| **Approval page** | Your page at `/device` where a signed-in user approves a code. | `verificationPath`, `<ApproveDevice>` | |
| **Machine token** | The secret a computer uses to connect to one website. Stored only in `~/.uncage/agent.yaml`. | | |
| **Revoke** | Disconnect a computer from a website for good; its token stops working. | `revokeMachine`, `uncage sites remove` | |
| **Runtime** | The coding agent that does the work: Claude Code (`claude`), Codex (`codex`) or an ACP agent (`acp-<id>`). | `RuntimeInfo`, `RuntimeAdapter` | |
| **ACP agent** | Any coding agent that speaks the Agent Client Protocol (Gemini CLI, OpenCode, …), offered as a runtime. | `runtimes.acp`, `uncage runtimes` | |
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
| **Hub store** | The hub’s database: computers, session index, outbox, tool-call state and audit, rate-limit counters, replicas. | `HubStore`, `pgliteHubStore`, `postgresHubStore` | |
| **Node** | One hub process or function instance. Several nodes share a store and a cluster adapter. | | |
| **Cluster adapter** | Shares presence and carries messages between hub nodes. | `ClusterAdapter`, `memoryCluster`, `redisCluster`, `postgresCluster` | |
| **Local policy** | Limits the user sets on their own computer for every website. | `localPolicy` in `~/.uncage/agent.yaml` | |
| **Activity log** | The local record of everything websites did on a computer. | `uncage activity` | |
| **Daemon** | Local Mode’s server, `uncage serve`, on `127.0.0.1:4783`. | `@uncage/server` | |
| **Proxy** | Local Mode’s same-origin route in your app that forwards to the daemon with its token. | `createUncageHandler`, `createUncageNodeHandler` | |
| **Draft** | A session-to-be in the UI, before the first prompt, holding settings and files. | `openDraft()`, `commitDraft()`, `isDraft` | |
