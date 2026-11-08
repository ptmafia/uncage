---
title: コーディングエージェント向け
description: Claude Code、Codexなどのコーディングエージェントがこのサイトをどう読めばよいか、インストールすべきスキル、Uncageを組み込むためのそのまま貼り付けられるプロンプトを紹介します。
---

このサイトは、人だけでなくコーディングエージェントにも読まれることを前提に書かれています。以下はすべて、エージェントが取得できるプレーンテキストです。

## エージェントに渡すもの

| リソース | URL | 用途 |
| --- | --- | --- |
| Uncageスキル | [`/skills/uncage/SKILL.md`](/docs/skills/uncage/SKILL.md) | 「ウェブサイトにUncageを組み込む」ためのもの：どのモードをいつ使うか、正確な手順、検証コマンド、落とし穴。スキルとしてインストールするか、URLをプロンプトに貼り付けます。 |
| インデックス | [`/llms.txt`](/docs/llms.txt) | 1ページ1行で、各ページのMarkdown URLを記載しています（[llmstxt.org](https://llmstxt.org)形式）。 |
| すべて | [`/llms-full.txt`](/docs/llms-full.txt) | すべてのガイドページを読む順に1つのMarkdownファイルにまとめたものです（自動生成されるAPIリファレンスはリンクのみで、本文は含みません）。 |
| 任意のページ | URLに`.md`を付ける | たとえば`https://uncage.vercel.app/docs/guides/define-tools.md`。各ページ上部の**View as Markdown**（Markdownで表示）リンクからも開けます。 |

Markdown版の中のリンクは他のページのMarkdown版を指しているので、エージェントはHTMLを解析せずにリンクをたどれます。

### スキルをインストールする

Claude Codeの場合は、プロジェクト内に置きます（すべてのプロジェクトで使うなら`~/.claude/skills/`に置きます）：

```sh
mkdir -p .claude/skills/uncage
curl -fsSL https://uncage.vercel.app/docs/skills/uncage/SKILL.md -o .claude/skills/uncage/SKILL.md
```

同じファイルはリポジトリの[`skills/uncage/SKILL.md`](https://github.com/ptmafia/uncage/blob/main/skills/uncage/SKILL.md)にもあります。

## プロンプト

各クイックスタートの冒頭には**コーディングエージェント用のプロンプトをコピーする**ブロックがあります。ここではそれらをまとめ、よくある追加作業のプロンプトを2つ加えています。

### Next.jsアプリにConnected モードを追加する

[Connected モード クイックスタート](/docs/ja/start/quickstart-connected/#コーディングエージェント用のプロンプトをコピーする)と同じプロンプトです：

```text wrap
Add Uncage Connected Mode to this Next.js (App Router) app, following https://uncage.vercel.app/docs/start/quickstart-connected.md exactly.
Read https://uncage.vercel.app/docs/skills/uncage/SKILL.md first and follow its rules.
1. Install @uncage/hub, @uncage/react-ui and zod.
2. Create lib/auth.ts, lib/tools.ts, lib/uncage-hub.ts, lib/hub-registry.ts, server.ts, app/uncage/page.tsx, app/device/page.tsx, app/device/actions.ts, app/device/approve-page.tsx and the headers in next.config.ts, as on that page.
3. Wire lib/auth.ts to this app's existing sign-in (find how the app reads the current user). Do not keep the development user unless the app has no sign-in at all.
4. Change the "dev" and "start" scripts to run server.ts with node (Node.js 22.18 or newer), set "type": "module" in package.json and "allowImportingTsExtensions": true in tsconfig.json.
5. Add .uncage-hub/ to .gitignore.
Verify: start the dev server, then curl -s http://localhost:3000/api/uncage/install.sh | head -3 prints the installer, and curl -sI http://localhost:3000/device shows the headers Content-Security-Policy: frame-ancestors 'none' and X-Frame-Options: DENY (no ?code=: unknown codes count as failed guesses and are rate limited). Report what you changed and anything you could not wire.
```

### Next.jsアプリにLocal モードを追加する

```text wrap
Add Uncage Local Mode to this Next.js (App Router) app, following https://uncage.vercel.app/docs/start/quickstart-local.md exactly.
1. npm i @uncage/server @uncage/react-ui @uncage/cli
2. Create app/api/uncage/[...path]/route.ts with createUncageHandler from @uncage/server/proxy (runtime 'nodejs', dynamic 'force-dynamic', export GET, POST, PATCH).
3. Create a page that renders <UncageProvider><AgentChat /></UncageProvider> from @uncage/react-ui inside a full-height container, and import '@uncage/react-ui/styles.css'.
Do not expose the daemon token to the browser and do not call the daemon from client code directly.
Verify: run "npx uncage doctor" and report each line; with "npx uncage serve --workspace <this repo>" running in another terminal and the app on http://localhost:3000, curl -s http://localhost:3000/api/uncage/runtimes returns a JSON array that contains "claude".
```

### 自社の機能をサイトツールとして公開する

```text wrap
Expose <feature, e.g. "create an invoice draft"> to Uncage as a site tool.
Read https://uncage.vercel.app/docs/guides/define-tools.md first.
Use defineTool from @uncage/hub with a zod input schema and a description written for the model. Check ownership with ctx.user.id inside the handler. Throw only user-safe messages. Set requiresConfirmation: true if the tool changes or publishes anything.
Add it to the hub's tools option and, if this app uses selectManifest, to the runs that need it. Add a unit test that calls the handler with a fake ctx.
```

### ハブを複数ノードに移行する

```text wrap
Make our Uncage hub run on several nodes, following https://uncage.vercel.app/docs/guides/multi-node.md.
Use postgresHubStore with DATABASE_URL and redisCluster with REDIS_URL; attach 'error' listeners to any pool or client we create ourselves; make sure the load balancer passes WebSocket upgrades on /api/uncage/agent; configure the client IP for rate limits.
```

## エージェント向けの経験則

- **名前は正確に**。APIの名前は、このサイトに書かれているとおりに使ってください（`createHub`、`defineTool`、`toNodeHandler`、`hub.attach`、`selectManifest`、`sessionStorage`、`ctx.files.pull`）。すべての用語は[用語集](/docs/ja/reference/glossary/)で定義されており、すべてのシグネチャは[自動生成されたAPIリファレンス](/docs/api/hub/)（英語）に載っています。
- **コードサンプルはコンパイルできます**。このサイトのTypeScriptサンプルはすべて、CIで最新のパッケージに対して型チェックされています。サンプルのタイトルに書かれたファイル（`lib/tools.ts`）は相対パスで互いをインポートします。表示されていないモジュール（アプリの`./auth`など）は、あなたが書くものです。
- **ウェブサイトからユーザーのコンピュータでシェルコマンドを実行する手段は、決して追加しないでください**。また、ウェブサイトから`bypassPermissions`を有効にしようとしないでください。Uncageは設計上、どちらも拒否します（[トラストモデル](/docs/ja/concepts/trust-model/)）。
- **推測せず、確認する**。組み込みを終えたら、スキルとクイックスタートにある検証コマンドを実行し、その出力をレポートに含めてください。
