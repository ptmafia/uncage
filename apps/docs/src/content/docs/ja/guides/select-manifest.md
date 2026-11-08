---
title: 実行ごとにツールとスキルを選ぶ
description: selectManifestを使い、ユーザー・プロンプト・セッションに応じて、実行ごとにClaude Codeに渡すサイトツールとスキルを決めます。
---

デフォルトでは、登録したすべてのツールとスキルがすべての実行に提供されます。`selectManifest`を使うと、実行ごとに選べます。

```ts nocheck
selectManifest?(ctx: { user: HubUser; prompt: string; sessionId: string; runtime: string }): Promise<{ tools: string[]; skills: string[] }>;
```

ハブは実行が始まるたび（`POST <basePath>/sessions/:id/runs`）、コンピュータに何かを送る前にこの関数を呼び出します。`runtime`はセッションのランタイムID（`claude-code`、`codex`など）です。提供するツールとスキルの**名前**を返してください。

## 例：プランとタスクで選ぶ

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

## ルール

- **名前だけを返します**。未知の名前と重複は無視されます。提供できるのは`tools` / `skills`に登録したものだけです。
- **助言ではなく強制です**。ハブは実行ごとにツールの一覧を記録します。登録済みでもその実行に提供されていないツールを呼び出すと、モデルが名前を推測したとしても`tool_failed`（`details.reason: 'not_in_manifest'`）で失敗します。ハブを通さずに開始された実行からの呼び出しは拒否されます。
- **実行単位で決まり、途中では変わりません**。選択は実行の開始時に行われ、終了まで維持されます。同じセッションでの追加のプロンプトは新しい実行なので、改めて選択されます。新しいツールやスキルをデプロイしても影響するのは次の実行からで、進行中の実行には影響しません。
- **高速に保ってください**。この関数は実行を開始するリクエストの中で動きます。例外を投げると実行の開始が失敗する（`500 internal_error`）ため、自前の参照処理の失敗は自分でハンドリングしてください。
- **上限**：1回の実行につきツール64個、スキル64個までです。これを超えて返すと、リクエストは`internal_error`（「selectManifest picked an invalid manifest」）で失敗します。
- `{ tools: [], skills: [] }`を返すと、ツールもスキルもない素のClaude Codeの実行になります。
- **サイトツールに対応しないランタイム**。サイトツールを呼び出せるのは、`capabilities.siteTools`を報告するランタイム（Claude Code）だけです。それ以外のランタイム（現時点ではCodex）では、何を返してもハブはツールを外してスキルだけを残し（Codexのランタイムはスキルを受け取りますが、まだ使いません）、実行は`system.warning`イベント（コード`site_tools_unsupported`）から始まります。このイベントは`<AgentChat>`に表示されます。そのランタイムには別のスキルを選びたい場合は、`runtime`を確認してください。

## 使いどころ

- **アクセス制御**。有料のツールや管理者専用のツールは、使ってよいユーザーにだけ提供します（それでもハンドラー内での権限チェックは必要です。`selectManifest`はモデルに何を見せるかを決め、ハンドラーは実際に何が起きるかを決めます）。
- **焦点を絞る**。ツールとスキルが少なく関連性が高いほど、モデルが間違える余地は減ります。プロンプトや、ユーザーが操作を始めたページ（`sessionId`をキーに自前のセッションデータに保存しておきます）に基づいて選びましょう。
- **段階的なリリース**。新しいツールをまず一部のユーザーにだけ提供します。
