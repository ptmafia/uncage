---
title: Uncage
description: Let your website drive Claude Code on your users’ own computers. The work happens on their machine; the conversation, the approvals and the results stay on your site.
template: splash
hero:
  tagline: Your website gives the instructions. Your user’s own Claude Code does the work, on their computer, and calls your website’s tools. The process and the results stay on your site.
  actions:
    - text: Connected Mode quickstart
      link: /docs/start/quickstart-connected/
      icon: right-arrow
    - text: How it works
      link: /docs/start/how-it-works/
      variant: minimal
    - text: For coding agents
      link: /docs/start/for-coding-agents/
      variant: minimal
---

## What Uncage is

Uncage is a set of npm packages that put Claude Code (and Codex) behind your own web UI, with approvals, streaming, Stop and reload-safe history.

It has two modes. Both use the same protocol, the same React hooks and the same `<AgentChat>` UI.

| | **Connected Mode** (new in 0.2) | **Local Mode** |
| --- | --- | --- |
| Who runs the agent | Each end user, on their own computer, with their own Claude Code login | You, on the machine that runs your app |
| What you add to your site | `@uncage/hub` in your Node backend, `<AgentChat>` in a page, an approval page at `/device` | A same-origin proxy route and `<AgentChat>` |
| What the user does | Runs one command once and approves the computer in the browser: `curl -fsSL https://your.site/api/uncage/install.sh \| bash` on macOS and Linux, `irm https://your.site/api/uncage/install.ps1 \| iex` on Windows | Nothing: it is your machine |
| Good for | SaaS products where users have Claude Code and want it to work with your product | Internal tools, desktop-style apps, developer dashboards |

## What your users get

- A chat on your website that drives **their** Claude Code. Nothing runs on your servers except your own code.
- Live streaming of the answer and of every tool step.
- **Allow / Deny** cards for commands, file edits and any of your tools that need confirmation.
- Stop, attachments, model, effort and permission-mode pickers, and history that survives a reload.
- With site storage on, the conversation stays readable on your site even when their computer is off.

## What you get as the website

- **Site tools.** Declare a capability with `defineTool` (a name, a zod schema, a handler). Claude Code sees it as an MCP tool. The handler runs **in your backend, as the signed-in user**, and can pull files from the run’s workspace (`ctx.files.pull`).
- **Skills.** Give Claude Code your house rules and templates as plain markdown. It loads them like any Claude Code skill.
- **Per-run choice.** `selectManifest` picks the tools and skills for each run from the prompt and the user.
- **Your auth, your storage, your scale.** `getUser(req)` plugs in your sign-in. Postgres and Redis adapters let the hub run on several nodes behind a load balancer.

## What Uncage never does

- It never sends code or shell commands from your website to a user’s machine. The hub sends only data: tool names and schemas, skill text, and a fixed set of commands such as “start a run”.
- It never shares one Claude login among users. Every machine uses its owner’s own Claude Code.
- A website can never switch on “bypass permissions”. Only the user can, in a file on their own computer.

See [the trust model](/docs/concepts/trust-model/) for the full list.

## Where to start

- **Building a website?** Read [How it works](/docs/start/how-it-works/), then do the [Connected Mode quickstart](/docs/start/quickstart-connected/) (about 15 minutes).
- **The agent runs on the same machine as your app?** The [Local Mode quickstart](/docs/start/quickstart-local/) takes 5 minutes.
- **Using a coding agent?** Give it [the Uncage skill](/docs/skills/uncage/SKILL.md) or [`llms.txt`](/docs/llms.txt). Every page is also available as plain markdown: add `.md` to its URL. See [For coding agents](/docs/start/for-coding-agents/).

:::note[Status]
Connected Mode is part of Uncage 0.2 (`@uncage/hub`, `@uncage/agent`, and the `uncage setup` / `uncage agent` commands in `@uncage/cli`). The agent side runs on **macOS, Linux and Windows** as a per-user background service, with Node.js 22 or newer (the installer sets it up). macOS is verified on a real device; Linux and Windows are CI verified, awaiting real-device confirmation. Claude Code is verified live; Codex is implemented but has not been run against a real binary, and it does not support site tools yet. Details: [compatibility](https://github.com/ptmafia/uncage/blob/main/docs/compatibility.md).
:::
