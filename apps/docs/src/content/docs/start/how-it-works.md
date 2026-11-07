---
title: How it works
description: The pieces of Connected Mode (browser, website with the hub, the user's computer with the agent) and what happens when a user connects, sends a task, and Claude Code calls one of your tools.
---

Connected Mode has three places where code runs. Only one of them is yours to deploy.

```mermaid
flowchart TB
  subgraph B["User's browser"]
    UI["Your pages<br/>AgentChat · ConnectMachine"]
  end
  subgraph S["Your website (Node backend)"]
    AUTH["Your sign-in<br/>getUser(req)"]
    HUB["@uncage/hub<br/>device login · routing<br/>site tools · skills · replica"]
    DB[("HubStore<br/>PGlite or Postgres")]
    CL[("ClusterAdapter<br/>memory or Redis")]
  end
  subgraph M["User's computer (macOS)"]
    AG["uncage agent<br/>(launchd service)"]
    CORE["@uncage/core<br/>local PGlite"]
    CC["Claude Code<br/>user's own login"]
    WS["~/Uncage/site/session/"]
  end
  UI -- "HTTPS + SSE, same origin<br/>/api/uncage/*" --> HUB
  HUB --- AUTH
  HUB --- DB
  HUB --- CL
  HUB <-- "outbound WSS<br/>/api/uncage/agent" --> AG
  AG --> CORE --> CC --> WS
```

- **The browser** talks only to your website, under `/api/uncage/*`, with the user’s normal session cookie. `<AgentChat>` from `@uncage/react-ui` does this for you.
- **Your website** mounts `@uncage/hub` in its Node backend. The hub does device login, keeps a WebSocket to every connected computer, routes browser requests to the right computer, runs your site tools, and (optionally) keeps a copy of every conversation.
- **The user’s computer** runs `uncage agent`, a background service installed by `uncage setup`. It dials **out** to your hub over WSS, so the user needs no public IP, port forwarding or tunnel. It runs Claude Code through `@uncage/core`, the same engine as Local Mode, in a fresh folder per session.

The session’s source of truth is the user’s computer (its local PGlite database). The hub stores an index of sessions, and with `sessionStorage: 'site'` an append-only replica of their events.

## What happens, step by step

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant B as Browser
  participant H as Hub (your site)
  participant A as uncage agent
  participant C as Claude Code
  Note over U,A: Connect (once per computer)
  U->>A: curl …/install.sh | bash, then uncage setup https://your.site
  A->>H: POST /device/code
  A-->>U: opens /device?code=ABCD-2345 in the browser
  U->>H: Approve (signed in, POST)
  A->>H: POST /device/token → machine token
  A->>H: WSS /api/uncage/agent
  H-->>B: computer online
  Note over U,C: Task
  U->>B: "Build a landing page and publish it"
  B->>H: POST /sessions, POST /sessions/:id/runs
  H->>H: selectManifest → tools + skills for this run
  H->>A: startRun (prompt + manifest)
  A->>C: run in the session folder, site tools as MCP, skills in .claude/skills
  C-->>A: text, tool steps, approval requests
  A-->>H: events (numbered)
  H-->>B: SSE stream
  Note over U,C: Tool call
  C->>A: mcp__site__publish_asset({assetId, dir})
  A-->>B: approval card (tool has requiresConfirmation)
  U->>B: Allow
  A->>H: tool_call
  H->>H: your handler(args, ctx) runs as the user
  H->>A: file pull of dir
  A-->>H: the files (at most 50 MiB)
  H-->>A: tool_result
  A->>C: tool result
  Note over U,C: Asset
  C-->>B: "Published" · run.completed
  H-->>B: your pages show the new asset
```

### 1. Connect

1. Your page shows two commands. `<ConnectMachine>` renders them from the hub (`GET /api/uncage/machines/install`):

   ```sh
   curl -fsSL https://your.site/api/uncage/install.sh | bash
   uncage setup https://your.site
   ```

2. `install.sh` is a fixed script served by the hub. It checks macOS, Node.js 22+ and npm, says how to install Claude Code if it is missing, and installs `@uncage/cli` globally. It downloads nothing else.
3. `uncage setup` starts a device login. It gets an 8-character code (valid for 10 minutes) and opens `https://your.site/device?code=…`.
4. The user, signed in to your site, checks the code and clicks **Approve**. Your approval page calls `hub.approveDevice(code, user)`. This binds the computer to that user.
5. The CLI receives a **machine token** (random, one per computer and website), saves it in `~/.uncage/agent.yaml` (mode 0600), and installs the agent as a launchd service.
6. The agent connects to `wss://your.site/api/uncage/agent`. Your page switches from “Waiting for your computer…” to “Connected”.

### 2. Send a task

1. The user types in `<AgentChat>`. The browser calls the hub’s browser API (the same shapes as the Local Mode daemon’s `/v1` API).
2. For every run, the hub calls your `selectManifest({ user, prompt, sessionId, runtime })` to pick the tools and skills this run may use. Without it, every registered tool and skill is offered. A runtime without site tool support (Codex) gets the skills only, and the session shows a `site_tools_unsupported` warning.
3. The hub sends `startRun` to the computer with the prompt and the **manifest**: the tools’ names, descriptions and JSON Schemas, and the skills’ text. No code.
4. The agent runs Claude Code in `~/Uncage/<site host>/<session id>/`. Site tools appear to Claude Code as `mcp__site__<name>`. Skills are written to `.claude/skills/<name>/SKILL.md` in that folder.
5. Every event (text, tool steps, approvals, run state) is numbered and stored locally first, then sent to the hub and on to the browser over SSE.

### 3. Claude Code calls your tool

1. Claude Code calls `mcp__site__publish_asset`. If the tool has `requiresConfirmation: true`, the user first gets an approval card in your UI, even in `bypassPermissions` mode.
2. The agent sends a `tool_call` to the hub. The node that holds the computer’s WebSocket runs the handler, after checking that the session belongs to this computer and its user, and that the tool was in the run’s manifest.
3. Your handler gets `ctx.user` (the session owner), `ctx.sessionId`, `ctx.runId`, `ctx.signal` and `ctx.files`. `ctx.files.pull('landing')` asks the agent for that folder of the session workspace. The agent refuses paths outside the workspace and never follows symlinks.
4. The handler’s return value goes back to Claude Code as the tool result. Every call is recorded in the hub’s store.

### 4. The result lives on your site

Your handler stored the files, so your own pages can show them. With `sessionStorage: 'site'` the conversation is replicated to your store too. Reload the page with the computer switched off and the whole process is still there; the composer says the computer is offline until it reconnects.

## Where things are stored

| What | Where |
| --- | --- |
| Machine token | Only in `~/.uncage/agent.yaml` on the user’s computer (mode 0600). The hub keeps a SHA-256 hash. |
| Session data (truth) | The user’s computer, `~/.uncage/sites/<site id>/data` (PGlite) |
| Session workspace | `~/Uncage/<site host>/<session id>/` on the user’s computer |
| Activity log | `~/.uncage/sites/<site id>/activity.log` on the user’s computer (`uncage activity`) |
| Machines, session index, tool-call audit | The hub’s `HubStore` (PGlite by default, Postgres for several nodes) |
| Conversation replica | The hub’s `HubStore`, only with `sessionStorage: 'site'` |
| Files your tools pulled | Wherever your handler puts them |

## Next

- [Connected Mode quickstart](/uncage/start/quickstart-connected/): build all of this into a Next.js app.
- [Concepts](/uncage/concepts/): the vocabulary, one section per idea.
- [Trust model](/uncage/concepts/trust-model/): what a website can and cannot do on a user’s computer.
