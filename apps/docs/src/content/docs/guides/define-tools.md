---
title: Define tools
description: Give Claude Code your website's capabilities with defineTool, run them as the signed-in user, ask for confirmation, return results, read files from the user's computer with ctx.files, and test handlers.
---

A **site tool** is a function of your website that Claude Code, running on the user’s computer, can call. You write it once, in your backend:

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

and pass it to the hub: `createHub({ …, tools: [lookupOrder] })`.

## What happens on a call

1. The user’s computer only ever receives the tool’s **name**, **description** and the **JSON Schema** of `input` (generated with `z.toJSONSchema`). Claude Code sees the tool as `mcp__site__lookup_order`.
2. When Claude Code calls it, the agent sends the call over its WebSocket. The hub node holding that connection checks that:
   - the session belongs to this computer and to its user;
   - the run was started through the hub, and the tool was in **this run’s manifest** (see [selectManifest](/uncage/guides/select-manifest/));
   - the arguments match `input`. They are parsed with it, so zod defaults and transforms apply. A mismatch fails with `invalid_request` and the handler is not called.
3. Your handler runs **in your backend** with the parsed arguments and a `ctx`.
4. The return value goes back to Claude Code as the tool result. The call is recorded in the hub’s store (`store.listToolCalls(sessionId)`), and the browser sees it in the session’s events as a normal tool step.

## The pieces of `defineTool`

| Field | Rules |
| --- | --- |
| `name` | `^[a-z][a-z0-9_]{0,47}$`, no `__`. Unique among your tools. |
| `description` | Up to 1000 characters. Written **for the model**: say what it does, when to use it, what it returns, and what to call before or after. |
| `input` | A zod schema (zod 4) for an object. Use `.describe()` on fields: descriptions end up in the JSON Schema the model reads. The schema must be representable as JSON Schema; keep it simple (no transforms that change the JSON shape the model must send). |
| `requiresConfirmation` | `true`: the user approves every call in your UI first. |
| `handler(args, ctx)` | `args` is typed from `input`. Returns a value (below) or throws. |

`createHub` throws at startup on an invalid tool (bad name, duplicate name, or a schema over 64 KB).

## `ctx`

| Property | What it is |
| --- | --- |
| `ctx.user` | `{ id, name? }`: the session’s owner, as your `getUser` returned it. Use it for every lookup and write. |
| `ctx.sessionId`, `ctx.runId` | The session and run that made the call. |
| `ctx.signal` | An `AbortSignal`, aborted when the call is abandoned: it timed out (`toolTimeoutMs`, 120 s by default), the run ended, or the computer disconnected. Pass it to your own I/O (`fetch(url, { signal: ctx.signal })`). |
| `ctx.files` | The [file channel](#reading-files-from-the-users-computer). |

## Returning results

- A **string** becomes one text block.
- Any other **JSON value** (object, array, number) becomes one JSON block.
- For full control, return a `ToolCallResult`: `{ content: [{ type: 'text', text }, { type: 'json', json }], isError?: boolean }`. `isError: true` tells the model the call did not work, without throwing.
- `undefined` / `null` becomes an empty result.

The result must fit in one WebSocket frame: a little under 1 MiB of JSON. Larger results fail with `tool_failed`. Return an id or a URL instead of a large payload.

## Errors

**A thrown error’s message is shown to the user and to the model.** It travels to the computer as the tool error (`tool_failed`, with your message). So:

- throw messages that help the model recover: `No order ord_9 in your account.`, `Title is already used; pick another.`;
- never put stack traces, SQL, internal hostnames, tokens or other users’ data in them;
- log the details on your side.

Other failures you may see in the tool step: `invalid_request` (arguments did not match `input`), `tool_failed` with `details.reason: 'not_in_manifest'` (the tool was not offered to this run), `'too_many_concurrent'` (more than `maxConcurrentToolCalls`, 8 by default, running for one computer), or a timeout.

## Asking for confirmation

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

With `requiresConfirmation: true`, every call shows an approval card in your UI (category `mcp`, titled with the tool’s description, showing `send_invoice({"invoiceId":…,"to":…})`). The handler only runs after **Allow**. This happens in every permission mode, including `bypassPermissions` and `auto`. If the user denies, Claude Code is told and usually asks what to change.

Use it for anything that publishes, sends, pays, deletes or is visible to other people. Tools without it run without a card (Claude Code may still show the step).

## Reading files from the user’s computer

The run’s files live on the user’s computer, in the session workspace. A handler reads them through `ctx.files` instead of having Claude Code paste contents into arguments:

- `ctx.files.pull(path, { maxBytes? })` returns every file under `path` (a file or a folder, relative to the workspace). Iterate it with `for await`. Limits: `maxBytes` total (default and maximum 50 MiB), 10 MiB per file.
- `ctx.files.read(path)` returns one file’s bytes (`Uint8Array`, at most 10 MiB). A folder fails with `invalid_request`, a missing path with `not_found`.

Rules the computer enforces:

- Paths must stay inside the session workspace. `../x`, absolute paths and anything resolving outside are refused.
- Symlinks are never followed.
- In a folder pull, files with more than one hard link are skipped and listed in `pull.skipped` (`{ path, reason }`) once iteration finishes.
- A pull is **all-or-nothing**: files are yielded only after all of them arrived. If anything fails part-way (too large, disconnect, the call ends), nothing is yielded and the loop throws.

Paths are normalized first (`./site//index.html` → `site/index.html`). Pulled `path`s are relative to the workspace (`site/index.html`), not to the folder you asked for.

This is the publishing tool from `examples/connected-demo`, slightly trimmed:

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

Treat pulled files as **untrusted input**: they were written by an AI agent on someone else’s computer. If you serve them (HTML, SVG), serve them from a sandbox. The demo serves published pages with `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; …` and shows them in `<iframe sandbox="allow-scripts">`; see its `lib/asset-csp.ts`.

## A tool that works with others

Tools often come in pairs: one creates something and returns an id, the next uses it. Say so in the descriptions and in the result, so the model chains them correctly:

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

A [skill](/uncage/guides/write-skills/) is the right place for the longer recipe (“first create_asset, then write the files, then publish_asset”).

## Testing a handler

A handler is a plain async function. Call it with a fake `ctx`:

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

`examples/connected-demo/lib/demo.test.ts` tests both demo tools this way, including a fake `ctx.files.pull`.

## Limits at a glance

| Limit | Value |
| --- | --- |
| Tool name | `^[a-z][a-z0-9_]{0,47}$`, no `__` |
| Description | 1000 characters |
| JSON Schema of `input` | 64 KB |
| Tools per run | 64 |
| Handler time | `toolTimeoutMs`, default 120 s |
| Concurrent calls per computer | `maxConcurrentToolCalls`, default 8 |
| Result size | just under 1 MiB of JSON |
| `ctx.files.pull` | 50 MiB total, 10 MiB per file |
| `ctx.files.read` | 10 MiB |

Codex sessions do not support site tools yet: a run with tools on a Codex session is refused with `unsupported_capability`.
