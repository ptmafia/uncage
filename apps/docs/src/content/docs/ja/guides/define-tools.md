---
title: ツールを定義する
description: defineTool でウェブサイトの機能を Claude Code に提供し、サインイン中のユーザーとして実行し、確認を求め、結果を返し、ctx.files でユーザーのコンピュータからファイルを読み、ハンドラーをテストする方法を説明します。
---

**サイトツール**とは、ユーザーのコンピュータで動く Claude Code が呼び出せる、ウェブサイトの関数です。バックエンドに一度書くだけで使えます。

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

あとはハブに渡すだけです：`createHub({ …, tools: [lookupOrder] })`。

## 呼び出し時に起きること

1. ユーザーのコンピュータが受け取るのは、ツールの**名前**、**説明**、`input` の **JSON Schema**（`z.toJSONSchema` で生成）だけです。Claude Code からは、このツールは `mcp__site__lookup_order` として見えます。
2. Claude Code がツールを呼び出すと、エージェントは WebSocket 経由で呼び出しを送ります。その接続を持つハブのノードは、次の点を確認します。
   - セッションがこのコンピュータとそのユーザーのものであること。
   - 実行がハブを通じて開始されており、ツールが**この実行のマニフェスト**に含まれていること（[selectManifest](/docs/ja/guides/select-manifest/) を参照）。
   - 引数が `input` に合致すること。引数は `input` でパースされるため、zod のデフォルト値や変換が適用されます。合致しない場合は `invalid_request` で失敗し、ハンドラーは呼ばれません。
3. ハンドラーは、パース済みの引数と `ctx` を受け取って**あなたのバックエンドで**実行されます。
4. 戻り値はツールの結果として Claude Code に返されます。呼び出しはハブのストアに記録され（`store.listToolCalls(sessionId)`）、ブラウザにはセッションのイベントの中で通常のツールのステップとして表示されます。

## `defineTool` の構成要素

| フィールド | ルール |
| --- | --- |
| `name` | `^[a-z][a-z0-9_]{0,47}$`。`__` は不可。ツール間で一意。 |
| `description` | 最大 1000 文字。**モデル向けに**書きます。何をするか、いつ使うか、何を返すか、前後に何を呼ぶべきかを書いてください。 |
| `input` | オブジェクトを表す zod スキーマ（zod 4）。フィールドには `.describe()` を付けます。説明はモデルが読む JSON Schema に含まれます。スキーマは JSON Schema で表現できる必要があるため、シンプルに保ってください（モデルが送るべき JSON の形を変えてしまう変換は使わないでください）。 |
| `requiresConfirmation` | `true` にすると、ユーザーがすべての呼び出しを事前に UI で承認します。 |
| `handler(args, ctx)` | `args` の型は `input` から導かれます。値（後述）を返すか、例外を投げます。 |

ツールが無効な場合（不正な名前、重複した名前、64 KB を超えるスキーマ）、`createHub` は起動時に例外を投げます。

## `ctx`

| プロパティ | 内容 |
| --- | --- |
| `ctx.user` | `{ id, name? }`：`getUser` が返した、セッションの所有者。すべての参照と書き込みに使ってください。 |
| `ctx.sessionId`、`ctx.runId` | 呼び出し元のセッションと実行。 |
| `ctx.signal` | `AbortSignal`。呼び出しが放棄されたとき、つまりタイムアウトした（`toolTimeoutMs`、デフォルト 120 秒）、実行が終了した、コンピュータが切断された場合に中断されます。自分の I/O に渡してください（`fetch(url, { signal: ctx.signal })`）。 |
| `ctx.files` | [ファイルチャネル](#ユーザーのコンピュータからファイルを読む)。 |

## 結果を返す

- **文字列**は 1 つのテキストブロックになります。
- それ以外の **JSON 値**（オブジェクト、配列、数値）は 1 つの JSON ブロックになります。
- 細かく制御したい場合は `ToolCallResult` を返します：`{ content: [{ type: 'text', text }, { type: 'json', json }], isError?: boolean }`。`isError: true` を指定すると、例外を投げずに呼び出しが失敗したことをモデルに伝えられます。
- `undefined` / `null` は空の結果になります。

結果は 1 つの WebSocket フレームに収まる必要があり、JSON で 1 MiB 弱が上限です。それより大きい結果は `tool_failed` で失敗します。大きなペイロードの代わりに ID や URL を返してください。

## エラー

**投げた例外のメッセージは、ユーザーとモデルに表示されます。** メッセージはツールのエラー（`tool_failed` とあなたのメッセージ）としてコンピュータに届きます。そのため、次の点に注意してください。

- モデルが立て直せるようなメッセージを投げます：`No order ord_9 in your account.`、`Title is already used; pick another.`。
- スタックトレース、SQL、内部のホスト名、トークン、他のユーザーのデータは決して含めないでください。
- 詳細は自分の側でログに残します。

ツールのステップには、ほかにも次のような失敗が表示されることがあります：`invalid_request`（引数が `input` に合致しない）、`details.reason: 'not_in_manifest'` 付きの `tool_failed`（ツールがこの実行に提供されていない）、`'too_many_concurrent'`（1 台のコンピュータで実行中の呼び出しが `maxConcurrentToolCalls`、デフォルト 8 を超えた）、またはタイムアウト。

## 確認を求める

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

`requiresConfirmation: true` を指定すると、呼び出しのたびに UI に承認カードが表示されます（カテゴリーは `mcp`、タイトルはツールの説明で、`send_invoice({"invoiceId":…,"to":…})` が表示されます）。ハンドラーは **Allow once**（許可）が押された後にだけ実行されます。これは `bypassPermissions` や `auto` を含む、すべてのパーミッションモードで同じです。ユーザーが拒否すると Claude Code にそれが伝えられ、通常は何を変えればよいかをユーザーに尋ねます。

公開、送信、支払い、削除など、他の人に見えるものには必ずこれを使ってください。指定のないツールはカードなしで実行されます（Claude Code がステップを表示することはあります）。

## ユーザーのコンピュータからファイルを読む

実行のファイルは、ユーザーのコンピュータのセッションのワークスペースにあります。ハンドラーは、Claude Code に内容を引数として貼り付けさせるのではなく、`ctx.files` を通じてファイルを読みます。

- `ctx.files.pull(path, { maxBytes? })` は、`path`（ワークスペースからの相対パスで指定するファイルまたはフォルダー）配下のすべてのファイルを返します。`for await` で反復処理します。上限は合計 `maxBytes`（デフォルト兼最大値は 50 MiB）、1 ファイルあたり 10 MiB です。
- `ctx.files.read(path)` は、1 つのファイルのバイト列（`Uint8Array`、最大 10 MiB）を返します。フォルダーを指定すると `invalid_request`、存在しないパスなら `not_found` で失敗します。

コンピュータが強制するルール：

- パスはセッションのワークスペースの内側でなければなりません。`../x`、絶対パス、外側に解決されるものはすべて拒否されます。
- シンボリックリンクがたどられることはありません。
- フォルダーの取得では、ハードリンクが 2 つ以上あるファイルはスキップされ、反復処理の完了後に `pull.skipped`（`{ path, reason }`）に一覧されます。
- 取得は**全部か無か**です。ファイルはすべてが届いてから初めて渡されます。途中で何か失敗した場合（サイズ超過、切断、呼び出しの終了）、何も渡されず、ループが例外を投げます。

パスはまず正規化されます（`./site//index.html` → `site/index.html`）。取得したファイルの `path` は、要求したフォルダーではなくワークスペースからの相対パス（`site/index.html`）です。

以下は `examples/connected-demo` の公開ツールを少し簡略化したものです。

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

取得したファイルは**信頼できない入力**として扱ってください。他人のコンピュータ上で AI エージェントが書いたものだからです。それらを配信する場合（HTML、SVG）は、サンドボックスから配信してください。デモでは、公開したページを `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; …` 付きで配信し、`<iframe sandbox="allow-scripts">` の中で表示しています。`lib/asset-csp.ts` を参照してください。

## 他のツールと連携するツール

ツールはペアで使われることがよくあります。一方が何かを作成して ID を返し、もう一方がそれを使う形です。モデルが正しくつなげられるよう、そのことを説明と結果の両方に書いてください。

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

より長い手順（「まず create_asset、次にファイルを書き、最後に publish_asset」）を書くなら、[スキル](/docs/ja/guides/write-skills/)が適しています。

## ハンドラーをテストする

ハンドラーはただの非同期関数です。偽の `ctx` を渡して呼び出します。

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

`examples/connected-demo/lib/demo.test.ts` は、偽の `ctx.files.pull` も含め、この方法でデモの 2 つのツールをテストしています。

## 上限の一覧

| 上限 | 値 |
| --- | --- |
| ツール名 | `^[a-z][a-z0-9_]{0,47}$`、`__` は不可 |
| 説明 | 1000 文字 |
| `input` の JSON Schema | 64 KB |
| 実行あたりのツール数 | 64 |
| ハンドラーの実行時間 | `toolTimeoutMs`、デフォルト 120 秒 |
| コンピュータあたりの同時呼び出し数 | `maxConcurrentToolCalls`、デフォルト 8 |
| 結果のサイズ | JSON で 1 MiB 弱 |
| `ctx.files.pull` | 合計 50 MiB、1 ファイルあたり 10 MiB |
| `ctx.files.read` | 10 MiB |

Codex のセッションはまだサイトツールに対応していません。Codex のセッションでツール付きの実行を開始すると、`unsupported_capability` で拒否されます。
