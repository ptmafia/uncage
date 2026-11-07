---
title: Choose tools and skills per run
description: Use selectManifest to decide, for each run, which of your site tools and skills Claude Code gets, based on the user, the prompt or the session.
---

By default every run is offered every tool and skill you registered. `selectManifest` lets you choose per run.

```ts nocheck
selectManifest?(ctx: { user: HubUser; prompt: string; sessionId: string; runtime: string }): Promise<{ tools: string[]; skills: string[] }>;
```

The hub calls it each time a run starts (`POST <basePath>/sessions/:id/runs`), before anything is sent to the computer. `runtime` is the session's runtime id (`claude-code`, `codex`, …). Return the **names** of the tools and skills to offer.

## Example: by plan and by task

```ts title="hub.ts"
import { createHub, defineTool, type HubUser } from '@uncage/hub';
import type { SkillSpec } from '@uncage/protocol';
import { z } from 'zod';

declare function getUser(req: Request): Promise<HubUser | null>;
declare function planOf(userId: string): Promise<'free' | 'pro'>;

const searchDocs = defineTool({
  name: 'search_docs',
  description: 'Search the website’s help articles. Returns titles and URLs.',
  input: z.object({ query: z.string().min(2) }),
  handler: async ({ query }) => [{ title: `Results for ${query}`, url: '/help' }],
});
const publishPage = defineTool({
  name: 'publish_page',
  description: 'Publish a folder of the workspace as a page on the user’s site. The user confirms each publish.',
  input: z.object({ dir: z.string() }),
  requiresConfirmation: true,
  handler: async ({ dir }) => ({ published: dir }),
});
const landingPage: SkillSpec = { name: 'landing-page', description: 'How to build a landing page for this site.', markdown: '…' };
const invoices: SkillSpec = { name: 'invoices', description: 'House rules for invoices.', markdown: '…' };

export const hub = await createHub({
  publicUrl: 'https://app.example.com',
  getUser,
  tools: [searchDocs, publishPage],
  skills: [landingPage, invoices],
  async selectManifest({ user, prompt }) {
    const tools = ['search_docs'];
    if ((await planOf(user.id)) === 'pro') tools.push('publish_page');
    const skills = /invoice|发票/i.test(prompt) ? ['invoices'] : ['landing-page'];
    return { tools, skills };
  },
});
```

## Rules

- **Names only.** Unknown names are ignored, and so are duplicates. You can only offer what you registered in `tools` / `skills`.
- **Enforced, not advisory.** The hub records the tool list of every run. A call to a registered tool that was not offered to that run fails with `tool_failed` (`details.reason: 'not_in_manifest'`), even if the model guesses its name. Calls from runs not started through the hub are refused.
- **Per run, not live.** The choice is made when the run starts and holds until it ends. A follow-up prompt in the same session is a new run and gets a new choice. Deploying new tools or skills affects the next run, never one in progress.
- **Keep it fast.** It runs on the request that starts the run. If it throws, starting the run fails (`500 internal_error`), so handle your own lookups’ failures.
- **Limits:** at most 64 tools and 64 skills per run. Returning more fails the request with `internal_error` (“selectManifest picked an invalid manifest”).
- Returning `{ tools: [], skills: [] }` gives a plain Claude Code run with none of your tools or skills.
- **Runtimes without site tools.** Only runtimes that report `capabilities.siteTools` (Claude Code) can call site tools. For any other runtime (Codex today) the hub drops the tools whatever you return, keeps the skills, and the run starts with a `system.warning` event (code `site_tools_unsupported`) that `<AgentChat>` shows. Check `runtime` if you would rather pick different skills for it.

## When to use it

- **Access control.** Offer paid or admin-only tools only to users who may use them. (Still check permissions inside the handler: `selectManifest` decides what the model sees, the handler decides what happens.)
- **Focus.** Fewer, relevant tools and skills give the model less to get wrong. Match on the prompt, or on the page the user started from (keep that in your own session data, keyed by `sessionId`).
- **Rollouts.** Offer a new tool to a few users first.
