---
title: For coding agents
description: How Claude Code, Codex and other coding agents should read this site, the skill to install, and ready-to-paste prompts for integrating Uncage.
---

This site is written to be read by coding agents as well as people. Everything below is plain text that an agent can fetch.

## What to give your agent

| Resource | URL | Use it for |
| --- | --- | --- |
| Uncage skill | [`/skills/uncage/SKILL.md`](/uncage/skills/uncage/SKILL.md) | “Integrate Uncage into a website”: when to use which mode, exact steps, verification commands, pitfalls. Install it as a skill, or paste its URL into the prompt. |
| Index | [`/llms.txt`](/uncage/llms.txt) | One line per page, with its markdown URL ([llmstxt.org](https://llmstxt.org) format). |
| Everything | [`/llms-full.txt`](/uncage/llms-full.txt) | All guide pages in reading order, in one markdown file (the generated API reference is linked, not included). |
| Any page | add `.md` to its URL | For example `https://ptmafia.github.io/uncage/guides/define-tools.md`. The **View as Markdown** link at the top of every page goes there. |

Links inside the markdown versions point to the markdown versions of other pages, so an agent can follow them without parsing HTML.

### Install the skill

For Claude Code, put it in your project (or in `~/.claude/skills/` for every project):

```sh
mkdir -p .claude/skills/uncage
curl -fsSL https://ptmafia.github.io/uncage/skills/uncage/SKILL.md -o .claude/skills/uncage/SKILL.md
```

The same file is in the repository at [`skills/uncage/SKILL.md`](https://github.com/ptmafia/uncage/blob/main/skills/uncage/SKILL.md).

## Prompts

Each quickstart starts with a **Copy prompt for your coding agent** block. Here they are together, plus two common follow-ups.

### Add Connected Mode to a Next.js app

```text wrap
Add Uncage Connected Mode to this Next.js (App Router) app.
Read https://ptmafia.github.io/uncage/skills/uncage/SKILL.md and follow it, then implement https://ptmafia.github.io/uncage/start/quickstart-connected.md.
Wire getUser / currentUser to this app's existing sign-in. Keep the /device page unframable (frame-ancestors 'none', X-Frame-Options: DENY) and decide with a Server Action.
Verify with the commands in the skill's "Verify" section and report the output.
```

### Add Local Mode to a Next.js app

```text wrap
Add Uncage Local Mode to this Next.js (App Router) app, following https://ptmafia.github.io/uncage/start/quickstart-local.md exactly.
Never send the daemon token to the browser. Verify with "npx uncage doctor" and report each line.
```

### Expose one of our features as a site tool

```text wrap
Expose <feature, e.g. "create an invoice draft"> to Uncage as a site tool.
Read https://ptmafia.github.io/uncage/guides/define-tools.md first.
Use defineTool from @uncage/hub with a zod input schema and a description written for the model. Check ownership with ctx.user.id inside the handler. Throw only user-safe messages. Set requiresConfirmation: true if the tool changes or publishes anything.
Add it to the hub's tools option and, if this app uses selectManifest, to the runs that need it. Add a unit test that calls the handler with a fake ctx.
```

### Move the hub to several nodes

```text wrap
Make our Uncage hub run on several nodes, following https://ptmafia.github.io/uncage/guides/multi-node.md.
Use postgresHubStore with DATABASE_URL and redisCluster with REDIS_URL; attach 'error' listeners to any pool or client we create ourselves; make sure the load balancer passes WebSocket upgrades on /api/uncage/agent; configure the client IP for rate limits.
```

## Rules of thumb for agents

- **Names are exact.** Use the API names exactly as written on this site (`createHub`, `defineTool`, `toNodeHandler`, `hub.attach`, `selectManifest`, `sessionStorage`, `ctx.files.pull`). The [glossary](/uncage/reference/glossary/) defines every term; the [generated API reference](/uncage/api/hub/) has every signature.
- **Code samples compile.** Every TypeScript sample on this site is type-checked against the current packages in CI. Files named in a sample’s title (`lib/tools.ts`) import each other with relative paths; a module that is not shown (such as your app’s `./auth`) is yours to write.
- **Never add a way for the website to run shell commands on the user’s computer**, and never try to enable `bypassPermissions` from the website. Uncage refuses both by design ([trust model](/uncage/concepts/trust-model/)).
- **Check, don’t assume.** After an integration, run the verification commands from the skill and the quickstart and include their output in your report.
