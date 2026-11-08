---
title: Write skills
description: Give Claude Code your website's rules, formats and templates as skills (SkillSpec), how they reach the user's computer, how to write ones the model actually follows, and their limits.
---

A **skill** tells Claude Code how your website wants something done: the format of a landing page, the structure of an app manifest, the steps to publish. It is plain markdown plus optional template files. Claude Code loads it when the task matches its description, like any [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills).

Tools are **what** Claude Code can do on your site; skills are **how** you want it done.

## Declare a skill

```ts title="skills.ts"
import type { SkillSpec } from '@uncage/protocol';

export const landingPage: SkillSpec = {
  name: 'landing-page',
  description:
    'Build a single-folder static landing page and publish it to the website with the create_asset and publish_asset tools.',
  markdown: `# Landing page for this website

Use this when the user asks for a landing page, product page or marketing page.

## Output format
- One folder in the workspace, e.g. \`landing/\`. Its entry point is \`landing/index.html\`.
- Plain HTML with inline \`<style>\` and \`<script>\`. No build step, no frameworks.
- No external resources: no CDNs, web fonts, remote images or analytics. The website shows the page
  in a sandbox that blocks network access.
- Start from \`template.html\` next to this file.

## Steps
1. Call \`create_asset\` with \`{ "title": "<page title>" }\` and keep the returned \`assetId\`.
2. Write \`landing/index.html\`.
3. Call \`publish_asset\` with \`{ "assetId": "<assetId>", "dir": "landing" }\`. The user confirms it;
   if they decline, stop and ask what to change.
4. Tell the user the page is published.
`,
  files: [
    {
      path: 'template.html',
      content: '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>{{title}}</title></head>\n<body><h1>{{headline}}</h1></body>\n</html>\n',
    },
  ],
};
```

Register it with the hub (`npm i @uncage/protocol` for the type, or let TypeScript infer it):

```ts nocheck
const hub = await createHub({ publicUrl, getUser, tools, skills: [landingPage] });
```

## How a skill reaches Claude Code

1. When a run starts, the hub puts the skills chosen for it (all of them, unless you use [`selectManifest`](/docs/guides/select-manifest/)) into the run’s manifest, as text.
2. The agent writes each one to the session workspace before Claude Code starts:

   ```text
   ~/Uncage/<site host>/<session id>/.claude/skills/landing-page/
   ├── SKILL.md          ← frontmatter (name, description) + your markdown
   └── template.html     ← each entry of files[]
   ```

   The folder is replaced on every run, so changes you deploy apply from the next run. Paths are checked: nothing is written outside `.claude/skills/<name>/`, and symlinks are never followed.
3. Claude Code sees the skill’s name and description, and loads the full text through its `Skill` tool when the task matches. Loading a skill needs no approval.

Skills are data. The hub never sends code for the computer to execute: a template file is just a file the model may read and copy.

## Writing skills the model follows

- **The description decides when it is used.** Name the user requests it covers (“landing page, product page, marketing page”) and the tools it drives. Keep it to one or two sentences.
- **Lead with the output format,** then numbered steps. Be concrete: folder names, file names, which tool to call with which arguments.
- **Say why for constraints** (“the website shows the page in a sandbox that blocks network access”), so the model makes good choices in cases you did not list.
- **Tell it what to do when the user declines** a confirmation, or when a tool fails.
- **Write in the language your users use**, or tell the model to reply in the user’s language.
- **Point at template files by name** (“start from `template.html` next to this file”).
- Test with real prompts on a real Claude Code: run the [connected demo](https://github.com/ptmafia/uncage/tree/main/examples/connected-demo) or your site against your own computer and read the tool steps.

## Limits

| | Limit |
| --- | --- |
| `name` | `^[a-z][a-z0-9-]{0,47}$` (lowercase, digits, dashes), unique |
| `description` | 1000 characters |
| `markdown` | 256 KiB |
| `files` | 200 per skill, 256 KiB each; relative forward-slash paths, unique (case-insensitive), not `SKILL.md` |
| Skills per run | 64 |

`createHub` throws at startup on an invalid or duplicate skill.

Skills are sent with every run, Codex runs included. The Claude Code runtime installs them in the session folder (`.claude/skills/`). The Codex runtime receives them but does not use them yet: it reports skill support as `unknown`, so skills on Codex are not verified.
