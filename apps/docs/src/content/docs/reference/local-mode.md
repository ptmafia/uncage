---
title: Local Mode in depth
description: The composer controls, attachments, bypass permissions, configuration (uncage.config.yaml), the proxy's host and origin checks, and the security model of the Local Mode daemon.
---

This page collects the details of Local Mode (`uncage serve` + the same-origin proxy). The composer and attachments behave the same in Connected Mode, except where noted.

## The composer

`<AgentChat>`’s prompt box (Claude Code style) has these controls. Each one really changes what the runtime gets; the live E2E suite against real Claude Code covers model, effort, the permission modes (including bypass), attachments and the running chip.

| Control | What it does |
| --- | --- |
| **Model** (sparkle) | The runtime’s own model list. For Claude Code that is `supportedModels()`, with `default` first |
| **Effort** (brain) | `low`, `medium`, `high`, `xhigh`, `max` |
| **Permissions** (shield) | `default` (ask before commands and edits), `acceptEdits` (edit files without asking, still ask for commands), `plan` (plan only, change nothing), `auto` (the runtime decides what needs you). `bypassPermissions` appears only when allowed (below) |
| **Attach** (+), drag and drop, paste | Images show as thumbnails, other files as chips. A pasted screenshot becomes an attachment, pasted text stays text |
| **Voice** (mic) | Dictation through the browser’s Web Speech API. Hidden in browsers without it |
| **N running** chip | Runs in progress in any session. Click it to jump to one |
| **Send / Stop** | Enter sends, Shift+Enter is a new line, Enter while an IME is composing never sends. Stop cancels the run |

Settings are stored per session. Before the first prompt they belong to the draft and apply when the session is created. In an open session a change applies **from the next run**; a run in progress and its open approval cards keep the settings it started with.

**Voice privacy.** The browser does the speech recognition, not Uncage. In Chrome the audio goes to Google’s speech service. Uncage only sees the resulting text. The first use shows a note saying so.

## Bypass permissions

`bypassPermissions` lets the agent run any command and edit any file without asking. It is off by default and never offered then; a crafted request gets `403 policy_denied`.

- **Local Mode:** set `security.allowBypass: true` in `uncage.config.yaml`, or start the daemon with `UNCAGE_ALLOW_BYPASS=1`. `uncage serve` then prints a warning.
- **Connected Mode:** only the user, with `localPolicy.allowBypass: true` in `~/.uncage/agent.yaml` on their computer ([local policy](/docs/guides/local-policy/)).

Even then, choosing it in the UI asks for confirmation, and a red banner stays on while it is active.

:::caution
Only allow bypass on a machine and workspace you are fine with the agent changing without review. It can delete files and run anything your user account can.
:::

## Attachments

- Images: `png jpg jpeg gif webp`. Files: `txt md json csv yaml yml xml html css js ts tsx jsx py go rs java rb sh sql log pdf`.
- At most 10 MB per file and 10 files per message. Claude Code caps images at 5 MB (the Anthropic API’s limit).
- Claude gets images inline. Other files are passed by path, and Claude reads them with its tools.
- Local Mode stores uploads in the session’s workspace at `<workspace>/.uncage/attachments/<sessionId>/<attachmentId>-<name>`; uploads that were never sent are deleted after 24 hours. Uncage writes `.uncage/.gitignore` (`*`) when it creates `.uncage/`, so attachments are never committed. `uncage doctor` warns when a git workspace does not ignore `.uncage/`.
- `useAttachmentUrl` / `client.attachmentUrl` return a URL under your same-origin proxy. A plain `<img src>` sends no `Authorization` header, so it only loads because the proxy adds the daemon token on the server.
- Connected Mode: uploads go through the hub (`POST <basePath>/sessions/:id/attachments`, up to 10 MiB) to the user’s computer, in one frame or in 256 KiB chunks.

## Configuration

Zero-config works. Optionally add `uncage.config.yaml` in the directory you run `uncage serve` from. Unknown keys are rejected by name.

```yaml
server:
  port: 4783
  eventRetentionDays: 7
security:
  allowedOrigins: []      # origins allowed to call the daemon directly (CORS-style); keep empty with the proxy
  approvalTtlMs: 600000
  allowBypass: false      # true offers the bypassPermissions mode (no approvals). Env: UNCAGE_ALLOW_BYPASS=1
workspace:
  allowedRoots: [/Users/me/code]
  default: /Users/me/code/my-app
runtimes:
  claude: { enabled: true }
  codex: { enabled: true }  # command: [codex, app-server]
```

Proxy environment (in your app): `UNCAGE_URL` (default `http://127.0.0.1:4783`), `UNCAGE_TOKEN` (default: read `~/.uncage/token`), `UNCAGE_ALLOWED_HOSTS`. If you start the daemon with `--token-file`, pass that token to the app as `UNCAGE_TOKEN`.

## Security model (Local Mode)

- **Loopback only.** The daemon binds to `127.0.0.1:4783`. Requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` get 403.
- **Bearer token.** Every `/v1/*` call needs `Authorization: Bearer <token>`. The token is in `~/.uncage/token` (mode 600). It is never logged, never put in events, and never sent to the browser. Without it: 401.
- **No cross-origin browsers.** A request with an `Origin` header gets 403 unless that origin is listed in `security.allowedOrigins` (empty by default). Browsers talk to the daemon only through your same-origin proxy.
- **The proxy rejects cross-origin requests too.** A request whose `Origin` differs from the origin the browser is on (the request scheme plus its `Host` header) gets `403 forbidden_origin`, and so does a non-GET request marked `Sec-Fetch-Site: cross-site`. Loopback names count as one origin when the scheme and port match (`localhost:3000` = `127.0.0.1:3000`).
- **DNS-rebinding guard.** The proxy only answers to allowed hostnames, checked against the browser’s `Host` header. By default these are `localhost`, `127.0.0.1` and `[::1]`, on any port. If your app is served under another hostname (a LAN name, a dev domain, a tunnel), list it:

  ```ts nocheck
  createUncageHandler({ allowedHosts: ['app.example.com', 'localhost'] });
  // or: UNCAGE_ALLOWED_HOSTS=app.example.com,localhost
  ```

  The list **replaces** the default, so add the loopback names back if you still use them. Use bare hostnames (no scheme or port). Behind a reverse proxy, forward the original `Host` (nginx: `proxy_set_header Host $host;`).
- **Approvals by default.** New sessions use `permissionMode: 'default'`. Pending approvals expire after 10 minutes.
- **Workspaces are fenced.** A session’s workspace must resolve (after `realpath`) inside `workspace.allowedRoots`. By default that is the directory `uncage serve` was started in, or the `--workspace` folder.
- **No telemetry.** Logs redact tokens and authorization headers, and they don’t contain prompt text at info level.

## Embedding the daemon

Instead of `uncage serve`, you can run the engine inside your own Node process: `createUncage()` from `@uncage/core` with `createUncageServer()` from `@uncage/server`. See the [generated API reference](/docs/api/core/).

## Codex status

The Codex adapter (`@uncage/runtime-codex`, which drives `codex app-server` over stdio JSON-RPC) is implemented and verified only against a fake app-server. Its protocol was checked against the official schema, but it has not run against a real `codex` binary. If you try it, set `runtimes.codex.command` if needed and report what you find. When Codex isn’t installed, the UI and `doctor` show it as **not installed** with the hint `npm i -g @openai/codex && codex login`. Codex does not support site tools (Connected Mode) yet.
