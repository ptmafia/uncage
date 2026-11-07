---
title: Concepts
description: 'The ideas behind Uncage, one section each: website and hub, machine and agent, session, run, events, approvals and permission modes, site tools, skills, manifest, file channel, storage, cluster, and the trust model.'
---

This page explains each idea once. The words are used the same way everywhere on this site; the [glossary](/uncage/reference/glossary/) has the one-line versions.

## Website and hub

The **website** is your web application. The **hub** (`@uncage/hub`) is the part of Uncage you mount inside its Node backend with `createHub()`. It serves, under one base path (default `/api/uncage`):

- the **browser API** your UI uses (the same request and response shapes as the Local Mode daemon’s `/v1` API, so `@uncage/client`, `@uncage/react` and `@uncage/react-ui` work unchanged);
- the **device endpoints** and `install.sh` that the CLI uses to connect a computer;
- the **WebSocket** that connected computers dial into (`<basePath>/agent`, via `hub.attach(server)`).

Each website runs its own hub. There is no Uncage cloud service in between.

A website has an **id** and a **name** that computers see when they connect. By default both come from the host of `publicUrl` (`app.example.com`); set `site: { id, name }` to choose them. Computers use the id for their local folders, so keep it stable.

## Machine (computer) and agent

A **machine** is one user’s computer connected to your website. In UI text it is called a **computer**. A user can connect several; each one has an id (`mch_…`), a name, its OS, the agent version, the runtimes it has (Claude Code, Codex) and whether it is **online**.

The **agent** is the background process on that computer: `uncage agent`, installed by `uncage setup` as a launchd service on macOS. In Chinese UI text it is called **守护进程**. One agent can be connected to several websites at once, with one machine token, one WebSocket and one workspace root per website.

A machine is **online** while its WebSocket is connected and answering heartbeats. The hub pings every 10 seconds and marks a silent machine offline after two missed pings, so the UI shows “offline” within about 30 seconds.

**Pairing** uses a device login, much like signing in to a TV app: `uncage setup <url>` gets a short **user code**, the user approves it on your website’s `/device` page, and the CLI receives a **machine token**. The token is stored only on the computer (`~/.uncage/agent.yaml`, mode 0600); the hub keeps its SHA-256 hash. Revoking a machine (from your website, or with `uncage sites remove` on the computer) makes the token stop working at once.

## Session

A **session** is one conversation, with one runtime, on one machine. Its id is chosen by the machine. Every session the hub returns carries `machineId`, so your UI can show the state of that computer.

- On the machine, each session gets its own **workspace** folder, `~/Uncage/<site host>/<session id>/`. A browser cannot choose the folder.
- The session’s **source of truth** is the machine’s local database (`~/.uncage/sites/<site id>/data`).
- A new session runs on the computer you pass as `machineId`, else on the user’s most recently seen computer that is online. With none online, creating a session fails with `machine_offline` (or `machine_not_found` if the user has never connected one).

## Run

A **run** is one prompt and everything the agent does to answer it. A session has at most one active run at a time (a second one gets `session_busy`). Run states:

| State | Meaning |
| --- | --- |
| `queued`, `running` | Working |
| `waiting_approval` | Paused on an approval card |
| `completed` | Finished normally |
| `failed` | Ended with an error |
| `cancelled` | Stopped by the user (Stop) |
| `interrupted` | The process went away mid-run (for example the agent restarted) |

Starting a run needs an `Idempotency-Key` header, so a retried request never starts a second run. `@uncage/client` sets it for you.

## Events

Everything that happens in a session is an **event** with a per-session **sequence** number: `session.created`, `run.started`, `message.delta`, `tool.started`, `approval.requested`, `run.completed`, and so on. The browser receives them over **SSE** (`GET <basePath>/sessions/:id/events`) and can resume after a disconnect from the last sequence it saw (`Last-Event-ID`). The machine writes events to its local database first, so a run keeps going while the network is down; when the connection comes back, the browser catches up without duplicates.

## Approvals and permission modes

When Claude Code wants to run a command, edit a file or call a tool that needs confirmation, the run pauses and the UI shows an **approval** card (**Allow** / **Deny**). The decision travels browser → hub → machine, and the machine decides atomically: if two tabs (or two hub nodes) answer at once, the first decision wins and the other gets `409`. Pending approvals expire after 10 minutes.

The **permission mode** of a session controls how much needs approval:

| Mode | Behaviour |
| --- | --- |
| `default` | Ask before commands and edits (Claude Code still auto-allows what it considers safe, such as reads) |
| `acceptEdits` | Edit files without asking; still ask for commands |
| `plan` | Plan only, change nothing |
| `auto` | The runtime decides what needs the user |
| `bypassPermissions` | Never ask. **Only available if the user enabled it on their own computer** (see [trust model](/uncage/concepts/trust-model/)) |

## Site tools

A **site tool** is a capability of your website that Claude Code can call, declared with `defineTool({ name, description, input, handler, requiresConfirmation? })`.

- The machine receives only the name, the description and the JSON Schema of `input`. Claude Code sees the tool as `mcp__site__<name>`.
- The **handler runs in your backend**, on the hub node that holds the machine’s connection, with `ctx.user` set to the session’s owner.
- `requiresConfirmation: true` makes every call show an approval card first, even in `bypassPermissions` mode.
- Every call is checked (the session belongs to this machine and user, the tool was offered to this run, the arguments match `input`) and recorded in the hub’s store.

Guide: [Define tools](/uncage/guides/define-tools/).

## Skills

A **skill** is instructions (markdown) plus optional template files, declared as a `SkillSpec` (`{ name, description, markdown, files? }`). The agent writes it to `.claude/skills/<name>/SKILL.md` in the session workspace before the run, and Claude Code loads it like any Claude Code skill: when the task matches its description. Skills are data, never code that the hub runs.

Guide: [Write skills](/uncage/guides/write-skills/).

## Manifest

The **manifest** is the set of tools and skills offered to one run. By default it is every tool and skill you registered. With `selectManifest({ user, prompt, sessionId, runtime })` you choose per run, for example only offering the publishing tools to users on a paid plan, or only the `invoice` skill when the prompt is about invoices. The hub records each run’s tool list; a call to a tool outside it fails with `tool_failed` (`details.reason: 'not_in_manifest'`). Changes to your tools or skills apply from the next run. Runtimes without site tool support (Codex) get the skills only, with a `site_tools_unsupported` warning in the session.

Guide: [Choose tools and skills per run](/uncage/guides/select-manifest/).

## File channel

The **file channel** lets a tool handler read files from the run’s workspace on the machine, instead of passing whole files through JSON arguments: `ctx.files.pull(path)` (a file or a folder, at most 50 MiB in total and 10 MiB per file) and `ctx.files.read(path)` (one file). The machine refuses paths outside the workspace, never follows symlinks, and skips hard-linked files in folders.

Guide: [Define tools → Reading files](/uncage/guides/define-tools/#reading-files-from-the-users-computer).

## Storage

There are two stores:

- **On the machine:** the session data (truth), in PGlite under `~/.uncage/sites/<site id>/`.
- **On the hub (`HubStore`):** machines, device codes, the session index (who owns which session, on which machine), run manifests, attachments uploaded through the hub and the tool-call audit. `pgliteHubStore` (embedded, one process) is the default; `postgresHubStore` is for several nodes.

**Session storage** (`sessionStorage` option) decides whether the hub also keeps the conversation:

- `'machine'` (default): history is read from the machine. While it is offline, the user cannot see past conversations.
- `'site'`: the machine replicates every event to the hub, in order, and resends from the last acknowledged sequence after a reconnect. History stays readable on your site while the machine is off.

Guide: [Site storage](/uncage/guides/site-storage/).

## Cluster

A hub can run on several **nodes** behind a load balancer. A machine’s WebSocket lives on one node; a browser request may land on another. The **cluster adapter** (`ClusterAdapter`) shares which node holds which machine and carries commands and events between nodes. `memoryCluster()` (default) is for one process; `redisCluster()` is for several. Every node must also share one `HubStore` (Postgres).

Guide: [Multi-node](/uncage/guides/multi-node/).

## Local policy and activity

The user’s computer has the last word. In `~/.uncage/agent.yaml`, `localPolicy.allowBypass` (default `false`) is the only switch that makes `bypassPermissions` possible, and `localPolicy.allowedPermissionModes` can cap the modes any website may use. Every command, tool call, file pull and approval a website causes is written to a local **activity log**, shown by `uncage activity`.

Guide: [Local policy](/uncage/guides/local-policy/).

## Trust model

The website is trusted to act for its signed-in users, within limits the website cannot change: no code or shell from the website, bypass only by the user, a local log of everything. Read [the trust model](/uncage/concepts/trust-model/).

## Local Mode

Everything above is **Connected Mode**. In **Local Mode**, there is no hub and no pairing: `uncage serve` (the **daemon**) runs on the same machine as your app, and your app talks to it through a same-origin **proxy** (`createUncageHandler` from `@uncage/server/proxy`) that adds the daemon’s bearer token on the server. Sessions, runs, events and approvals work the same way. See the [Local Mode quickstart](/uncage/start/quickstart-local/).
