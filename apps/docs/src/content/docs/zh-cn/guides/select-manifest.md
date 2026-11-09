---
title: 按运行选择工具和技能
description: 用 selectManifest 根据用户、提示词或会话，为每次运行决定 Claude Code 能拿到你的哪些网站工具和技能。
---

默认情况下，每次运行都会提供你注册的全部工具和技能。`selectManifest` 让你按运行选择。

```ts nocheck
selectManifest?(ctx: { user: HubUser; prompt: string; sessionId: string; runtime: string }): Promise<{ tools: string[]; skills: string[] }>;
```

每次运行开始时（`POST <basePath>/sessions/:id/runs`），hub 会在向电脑发送任何内容之前调用它。`runtime` 是会话的运行时 id（`claude`、`codex`……）。返回要提供的工具和技能的**名称**。

## 示例：按套餐和按任务选择

```ts title="hub.ts"
import { createHub, defineTool, type HubStore, type HubUser } from '@uncage/hub';
import type { SkillSpec } from '@uncage/protocol';
import { z } from 'zod';

declare function getUser(req: Request): Promise<HubUser | null>;
declare const store: HubStore; // pgliteHubStore or postgresHubStore, see Mount the hub
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
  store,
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

## 规则

- **只认名称。** 未知的名称会被忽略，重复的也一样。你只能提供在 `tools` / `skills` 里注册过的内容。
- **强制执行，而不只是建议。** hub 会记录每次运行的工具列表。调用一个已注册、但没有提供给这次运行的工具，会以 `tool_failed`（`details.reason: 'not_in_manifest'`）失败，即使模型猜中了它的名称。不是经 hub 启动的运行发起的调用会被拒绝。
- **按运行决定，而不是实时生效。** 选择在运行开始时做出，并一直保持到运行结束。同一会话里的后续提示词是一次新的运行，会重新选择。部署新的工具或技能只影响下一次运行，绝不影响进行中的运行。
- **保持快速。** 它在启动运行的那个请求上执行。如果它抛错，启动运行就会失败（`500 internal_error`），所以请自己处理查询失败的情况。
- **限制：** 每次运行最多 64 个工具和 64 个技能。返回更多会让请求以 `internal_error` 失败（“selectManifest picked an invalid manifest”）。
- 返回 `{ tools: [], skills: [] }` 会得到一次不带你任何工具和技能的普通 Claude Code 运行。
- **不支持网站工具的运行时。** 只有报告了 `capabilities.siteTools` 的运行时（Claude Code）才能调用网站工具。对其他任何运行时（目前是 Codex），无论你返回什么，hub 都会丢弃工具、保留技能（Codex 运行时会收到技能，但目前还不使用），并且运行开始时会产生一个 `system.warning` 事件（代码 `site_tools_unsupported`），由 `<AgentChat>` 显示。如果想为它挑选不同的技能，请检查 `runtime`。

## 什么时候用

- **访问控制。** 只向有权使用的用户提供付费或仅限管理员的工具。（handler 里仍要检查权限：`selectManifest` 决定模型能看到什么，handler 决定实际会发生什么。）
- **聚焦。** 工具和技能越少、越相关，模型越不容易出错。可以按提示词匹配，或按用户开始对话的页面匹配（把它保存在你自己的会话数据里，以 `sessionId` 为键）。
- **灰度发布。** 先把新工具提供给少数用户。
