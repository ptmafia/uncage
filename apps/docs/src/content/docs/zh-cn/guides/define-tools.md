---
title: 定义网站工具
description: 用 defineTool 把你网站的能力交给 Claude Code：以已登录用户身份运行、请求确认、返回结果、用 ctx.files 从用户电脑读取文件，以及测试 handler。
---

**网站工具**是你网站上的一个函数，运行在用户电脑上的 Claude Code 可以调用它。你只需在后端写一次：

```ts title="tools.ts"
import { defineTool } from '@uncage/hub';
import { z } from 'zod';

/** Stand-in for your database. */
declare const db: {
  orders: { find(q: { id: string; userId: string }): Promise<{ id: string; status: string; total: number } | null> };
};

export const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up one of the signed-in user’s orders by its id (for example "ord_123"). Returns status and total.',
  input: z.object({
    id: z.string().regex(/^ord_\w+$/).describe('The order id, as shown on the website'),
  }),
  handler: async ({ id }, ctx) => {
    const order = await db.orders.find({ id, userId: ctx.user.id });
    if (!order) throw new Error(`No order ${id} in your account.`);
    return { id: order.id, status: order.status, total: order.total };
  },
});
```

然后把它交给 hub：`createHub({ …, tools: [lookupOrder] })`。

## 一次调用时发生了什么

1. 用户电脑只会收到工具的**名称**、**描述**和 `input` 的 **JSON Schema**（由 `z.toJSONSchema` 生成）。Claude Code 把这个工具看作 `mcp__site__lookup_order`。
2. Claude Code 调用它时，守护进程把调用发给 hub（通过它的 WebSocket，或者在 FaaS 模式下以 HTTP POST 发送）。收到调用的 hub 实例会检查：
   - 会话属于这台电脑及其用户；
   - 这次运行是经 hub 启动的，而且工具在**这次运行的清单**里（见 [selectManifest](/docs/zh-cn/guides/select-manifest/)）；
   - 参数符合 `input`。参数会用它解析，所以 zod 的默认值和 transform 都会生效。不符合时以 `invalid_request` 失败，handler 不会被调用。
3. 你的 handler **在你的后端**运行，拿到解析后的参数和一个 `ctx`。
4. 返回值作为工具结果交还给 Claude Code。这次调用会记录在 hub 的存储里（`store.listToolCalls(sessionId)`），浏览器则在会话事件里把它看作一个普通的工具步骤。

## `defineTool` 的各个字段

| 字段 | 规则 |
| --- | --- |
| `name` | `^[a-z][a-z0-9_]{0,47}$`，不能含 `__`。在你的工具中唯一。 |
| `description` | 最多 1000 个字符。**写给模型看**：说明它做什么、什么时候用、返回什么，以及之前或之后该调用什么。 |
| `input` | 一个描述对象的 zod schema（zod 4）。在字段上用 `.describe()`：描述会进入模型读取的 JSON Schema。schema 必须能表示为 JSON Schema；尽量保持简单（不要用会改变模型所需发送的 JSON 结构的 transform）。 |
| `requiresConfirmation` | `true`：每次调用都要用户先在你的界面里批准。 |
| `handler(args, ctx)` | `args` 的类型由 `input` 推导。返回一个值（见下文）或抛出错误。 |

工具无效时（名称不合法、名称重复，或 schema 超过 64 KB），`createHub` 会在启动时抛错。

## `ctx`

| 属性 | 含义 |
| --- | --- |
| `ctx.user` | `{ id, name? }`：会话所属用户，即你的 `getUser` 返回的值。每次查询和写入都要用它。 |
| `ctx.sessionId`、`ctx.runId` | 发起这次调用的会话和运行。 |
| `ctx.signal` | 一个 `AbortSignal`，调用被放弃时触发：超时（`toolTimeoutMs`，默认 120 秒）、运行结束（停止），或者 hub 正在关闭且 `toolDrainMs` 已用完。连接断开**不会**触发它：结果会被存储，等电脑重连后再送达。把它传给你自己的 I/O（`fetch(url, { signal: ctx.signal })`）。 |
| `ctx.files` | [文件通道](#从用户电脑读取文件)。 |

## 返回结果

- **字符串**会变成一个文本块。
- 其他任何 **JSON 值**（对象、数组、数字）会变成一个 JSON 块。
- 想完全掌控，就返回 `ToolCallResult`：`{ content: [{ type: 'text', text }, { type: 'json', json }], isError?: boolean }`。`isError: true` 会告诉模型调用没有成功，而不必抛错。
- `undefined` / `null` 会变成空结果。

结果必须能放进一条消息：略小于 1 MiB 的 JSON。更大的结果会以 `tool_failed` 失败。请返回 id 或 URL，而不是大块数据。

## 错误

**抛出的错误消息会展示给用户和模型。** 它作为工具错误（`tool_failed`，带你的消息）传到电脑上。所以：

- 抛出能帮助模型纠正的消息：`No order ord_9 in your account.`、`Title is already used; pick another.`；
- 绝不要在里面放堆栈、SQL、内部主机名、令牌或其他用户的数据；
- 详细信息记在你自己这边的日志里。

工具步骤里还可能看到这些失败：`invalid_request`（参数不符合 `input`）、带 `details.reason: 'not_in_manifest'` 的 `tool_failed`（这次运行没有提供这个工具）、`'too_many_concurrent'`（一台电脑同时运行的调用超过 `maxConcurrentToolCalls`，默认 8 个），或者超时。

## 请求确认

```ts title="invoice-tools.ts"
import { defineTool } from '@uncage/hub';
import { z } from 'zod';

declare const mailer: { send(o: { from: string; to: string; subject: string; text: string }): Promise<void> };

export const sendInvoice = defineTool({
  name: 'send_invoice',
  description: 'Email an invoice to the customer. The user confirms each send.',
  input: z.object({ invoiceId: z.string(), to: z.string().email() }),
  requiresConfirmation: true,
  handler: async ({ invoiceId, to }, ctx) => {
    await mailer.send({ from: ctx.user.id, to, subject: `Invoice ${invoiceId}`, text: '…' });
    return `Sent ${invoiceId} to ${to}.`;
  },
});
```

设置 `requiresConfirmation: true` 后，每次调用都会在你的界面里弹出审批卡片（类别为 `mcp`，标题是工具的描述，内容显示 `send_invoice({"invoiceId":…,"to":…})`）。只有点击**允许执行**后 handler 才会运行。所有权限模式下都是如此，包括 `bypassPermissions` 和 `auto`。如果用户拒绝，Claude Code 会收到通知，通常会询问要做哪些修改。

凡是发布、发送、付款、删除或对他人可见的操作，都应使用它。没有设置的工具不弹卡片直接运行（Claude Code 仍可能显示这个步骤）。

## 从用户电脑读取文件

运行产生的文件在用户电脑上的会话工作区里。handler 通过 `ctx.files` 读取它们，而不是让 Claude Code 把内容贴进参数：

- `ctx.files.pull(path, { maxBytes? })` 返回 `path`（一个文件或文件夹，相对于工作区）下的所有文件。用 `for await` 遍历。限制：总计 `maxBytes`（默认值和最大值都是 50 MiB），单个文件 10 MiB。
- `ctx.files.read(path)` 返回单个文件的字节（`Uint8Array`，最多 10 MiB）。读文件夹会以 `invalid_request` 失败，路径不存在则返回 `not_found`。

电脑强制执行的规则：

- 路径必须留在会话工作区之内。`../x`、绝对路径以及任何解析到外部的路径都会被拒绝。
- 从不跟随符号链接。
- 拉取文件夹时，有多个硬链接的文件会被跳过，遍历结束后列在 `pull.skipped`（`{ path, reason }`）里。
- 拉取是**全有或全无**的：所有文件都到齐之后才会逐个产出。中途有任何失败（太大、断开、调用结束），就什么都不产出，循环抛错。

路径会先被规范化（`./site//index.html` → `site/index.html`）。拉取结果中的 `path` 相对于工作区（`site/index.html`），而不是相对于你请求的文件夹。

下面是 `examples/connected-demo` 里的发布工具，略有删减：

```ts title="publish.ts"
import { defineTool } from '@uncage/hub';
import { z } from 'zod';

/** Your asset storage. */
declare const assets: {
  get(id: string): Promise<{ id: string; owner: string } | null>;
  publish(id: string, files: Array<{ path: string; data: Uint8Array }>): Promise<{ url: string }>;
};

export const publishAsset = defineTool({
  name: 'publish_asset',
  description:
    'Publish a folder of the workspace as the asset’s files (index.html entry, at most 20 MB). The user confirms each publish.',
  input: z.object({
    assetId: z.string().min(1).max(40).describe('The assetId returned by create_asset'),
    dir: z.string().trim().min(1).max(200).describe('Folder relative to the workspace, e.g. "landing"'),
  }),
  requiresConfirmation: true,
  handler: async ({ assetId, dir }, ctx) => {
    const asset = await assets.get(assetId);
    // Same message for "missing" and "someone else's": never confirm that another user's id exists.
    if (!asset || asset.owner !== ctx.user.id) throw new Error(`Unknown asset ${assetId}. Create one with create_asset first.`);

    const pull = ctx.files.pull(dir, { maxBytes: 20 * 1024 * 1024 });
    const prefix = `${dir.replace(/^\.\/+|\/+$/g, '')}/`;
    const files: Array<{ path: string; data: Uint8Array }> = [];
    for await (const f of pull) {
      if (!f.path.startsWith(prefix)) throw new Error(`"${dir}" must be a folder containing index.html.`);
      files.push({ path: f.path.slice(prefix.length), data: f.data });
    }
    const { url } = await assets.publish(assetId, files);
    return { assetId, url, files: files.map((f) => f.path), ...(pull.skipped.length > 0 ? { skipped: pull.skipped } : {}) };
  },
});
```

把拉取到的文件当作**不可信的输入**：它们是 AI agent 在别人电脑上写出来的。如果要对外提供它们（HTML、SVG），请放在沙箱里。演示项目用 `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; …` 提供已发布的页面，并在 `<iframe sandbox="allow-scripts">` 里展示；见它的 `lib/asset-csp.ts`。

## 与其他工具配合的工具

工具常常成对出现：一个创建某样东西并返回 id，下一个使用这个 id。在描述和结果里写清楚，模型才能正确地串联它们：

```ts title="create.ts"
import { defineTool } from '@uncage/hub';
import { z } from 'zod';

declare const assets: { create(o: { owner: string; title: string; sessionId: string }): Promise<{ id: string }> };

export const createAsset = defineTool({
  name: 'create_asset',
  description: 'Create a new, empty asset on the website (for example a landing page) and get its assetId. Call this before publish_asset.',
  input: z.object({ title: z.string().trim().min(1).max(120).describe('Title shown in the website gallery') }),
  handler: async ({ title }, ctx) => {
    const asset = await assets.create({ owner: ctx.user.id, title, sessionId: ctx.sessionId });
    return {
      assetId: asset.id,
      next: 'Build the page in a folder of the workspace (index.html at its top level), then call publish_asset with this assetId and that folder.',
    };
  },
});
```

更长的流程（“先 create_asset，再写文件，然后 publish_asset”）适合写进[技能](/docs/zh-cn/guides/write-skills/)。

## 测试 handler

handler 就是一个普通的 async 函数。用一个假的 `ctx` 调用它：

```ts title="tools.test.ts"
import type { FilePull, ToolContext } from '@uncage/hub';
import { describe, expect, it } from 'vitest';
import { lookupOrder } from './tools.ts';

function fakeCtx(userId: string): ToolContext {
  const empty: FilePull = { skipped: [], async *[Symbol.asyncIterator]() {} };
  return {
    user: { id: userId },
    sessionId: 'ses_test',
    runId: 'run_test',
    signal: new AbortController().signal,
    files: { pull: () => empty, read: async () => new Uint8Array() },
  };
}

describe('lookup_order', () => {
  it('refuses other users’ orders', async () => {
    await expect(lookupOrder.handler({ id: 'ord_1' }, fakeCtx('someone-else'))).rejects.toThrow(/No order/);
  });
});
```

`examples/connected-demo/lib/demo.test.ts` 用这种方式测试了演示里的两个工具，包括一个假的 `ctx.files.pull`。

## 连接断开或实例停止时

电脑和 hub 之间的连接随时都会断开（笔记本休眠、网络切换、Serverless 平台切断长请求、部署重启节点）。Uncage 保证这些情况对工具调用来说是安全的：

- **连接断开：恰好一次。** 每次调用都有一个 id，hub 会存储调用本身，并在 handler 返回后存储它的结果。电脑重连后会用相同的 id 再次发送这次调用；hub 直接返回已存储的结果，而不会再运行一次你的 handler。如果这次调用还在别处运行，hub 会等它完成，而不是重新开始。已存储的结果保留 24 h。
- **实例在 handler 执行中途停止：最多一次。** 如果运行 handler 的 hub 进程或函数实例挂掉了（崩溃、部署、平台时间上限），谁也无法知道它执行到了哪一步。等这次调用的租期（`toolTimeoutMs` + 10 s）用完，它会以这条消息失败：“Site tool "<name>" timed out on the website. Please try again.”（`tool_failed`，`details.reason: 'interrupted'`）。它永远不会被自动重新执行；模型会看到这个错误，通常会再试一次，而那是一次新的调用。
- **`hub.close()`**（优雅关闭）会让正在运行的 handler 在 `toolDrainMs`（5 s）内收尾，之后以同样的错误中止它们。
- **Cloudflare Workers** 可能会在客户端断开时取消请求中的工作。传入 `waitUntil`（`ctx.waitUntil.bind(ctx)`），hub 就会让 handler 继续运行，连接断开时仍然是恰好一次。不传的话，就会变成最多一次的情况。见 [Workers → 常见问题](/docs/zh-cn/deploy/cloudflare-workers/#在-workers-上网站工具会恰好执行一次吗)。

这对你的 handler 意味着：

- 让它们的耗时**短于平台的时间上限**（Vercel：`maxDuration`，默认 300 s；让 `toolTimeoutMs` 不超过它）。耗时长的工作应该交给后台任务：返回任务 id，再给模型提供第二个工具来查询进度。
- **尽量让它们具备幂等性**（例如用从参数推导出的键做 `upsert`），这样调用被中断后模型重试也不会造成问题。
- 你自己的 I/O 要使用 `ctx.signal`，这样被放弃的调用会停止它的工作。

## 限制一览

| 限制 | 值 |
| --- | --- |
| 工具名称 | `^[a-z][a-z0-9_]{0,47}$`，不能含 `__` |
| 描述 | 1000 个字符 |
| `input` 的 JSON Schema | 64 KB |
| 每次运行的工具数 | 64 |
| handler 运行时间 | `toolTimeoutMs`，默认 120 秒（在 FaaS 模式下还要在平台的请求时间上限之内） |
| 每台电脑的并发调用数 | `maxConcurrentToolCalls`，默认 8 |
| 结果大小 | 略小于 1 MiB 的 JSON |
| `ctx.files.pull` | 总计 50 MiB，单个文件 10 MiB |
| `ctx.files.read` | 10 MiB |

Codex 会话暂不支持网站工具。在 Codex 会话上发起的运行不会被拒绝：hub 会丢弃工具，技能照常发送，会话里会显示一个代码为 `site_tools_unsupported` 的 `system.warning`。见[按运行选择工具和技能](/docs/zh-cn/guides/select-manifest/)。
