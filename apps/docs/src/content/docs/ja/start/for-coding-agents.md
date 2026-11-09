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
| 任意のページ | URLに`.md`を付ける | たとえば`https://uncage-dev.vercel.app/docs/guides/define-tools.md`。各ページ上部の**View as Markdown**（Markdownで表示）リンクからも開けます。 |

Markdown版の中のリンクは他のページのMarkdown版を指しているので、エージェントはHTMLを解析せずにリンクをたどれます。

### スキルをインストールする

Claude Codeの場合は、プロジェクト内に置きます（すべてのプロジェクトで使うなら`~/.claude/skills/`に置きます）：

```sh
mkdir -p .claude/skills/uncage
curl -fsSL https://uncage-dev.vercel.app/docs/skills/uncage/SKILL.md -o .claude/skills/uncage/SKILL.md
```

同じファイルはリポジトリの[`skills/uncage/SKILL.md`](https://github.com/ptmafia/uncage/blob/main/skills/uncage/SKILL.md)にもあります。

## プロンプト

各クイックスタートの冒頭には**コーディングエージェント用のプロンプトをコピーする**ブロックがあります。ここではそれらをまとめ、よくある追加作業のプロンプトも加えています。

### このプロジェクトに合った組み込み方を選ぶ

ウェブサイトがどこで動くかわからないときは、まずこれを使ってください。プラットフォームごとにどのページに従うべきかは、スキルがエージェントに伝えます。

```text wrap
Add Uncage Connected Mode to this website. Read https://uncage-dev.vercel.app/docs/skills/uncage/SKILL.md and https://uncage-dev.vercel.app/docs/start/choose-deployment-mode.md first.
Find out where this site runs (package.json scripts, vercel.json, wrangler.toml, netlify.toml, Dockerfile, Procfile, the hosting docs in the repo) and tell me which deployment mode fits and why:
- a long-running Node server or container → traditional mode, https://uncage-dev.vercel.app/docs/deploy/node.md (or the Next.js custom server in https://uncage-dev.vercel.app/docs/start/quickstart-connected.md);
- Next.js on Vercel → FaaS mode, https://uncage-dev.vercel.app/docs/deploy/vercel.md;
- Cloudflare Workers → FaaS mode, https://uncage-dev.vercel.app/docs/deploy/cloudflare-workers.md;
- another Fetch platform → FaaS mode, https://uncage-dev.vercel.app/docs/deploy/other-fetch-platforms.md.
Then follow that page exactly, wire getUser to this app's existing sign-in, and run every item of its Verify checklist that can run locally. Report the mode you chose, the files you changed, the checklist output, and which environment variables I must set before deploying.
```

### Next.jsアプリにConnected モードを追加する

[Connected モード クイックスタート](/docs/ja/start/quickstart-connected/#コーディングエージェント用のプロンプトをコピーする)と同じプロンプトです：

```text wrap
Add Uncage Connected Mode to this Next.js (App Router) app, following https://uncage-dev.vercel.app/docs/start/quickstart-connected.md exactly.
Read https://uncage-dev.vercel.app/docs/skills/uncage/SKILL.md first and follow its rules.
1. Install @uncage/hub, @uncage/react-ui and zod.
2. Create lib/auth.ts, lib/tools.ts, lib/uncage-hub.ts, lib/hub-registry.ts, server.ts, app/uncage/page.tsx, app/device/page.tsx, app/device/actions.ts, app/device/approve-page.tsx and the headers in next.config.ts, as on that page.
3. Wire lib/auth.ts to this app's existing sign-in (find how the app reads the current user). Do not keep the development user unless the app has no sign-in at all.
4. Change the "dev" and "start" scripts to run server.ts with node (Node.js 22.18 or newer), set "type": "module" in package.json and "allowImportingTsExtensions": true in tsconfig.json.
5. Add .uncage-hub/ to .gitignore.
Verify: start the dev server, then curl -s http://localhost:3000/api/uncage/install.sh | head -3 prints the installer, and curl -sI http://localhost:3000/device shows the headers Content-Security-Policy: frame-ancestors 'none' and X-Frame-Options: DENY (no ?code=: unknown codes count as failed guesses and are rate limited). Report what you changed and anything you could not wire.
```

### VercelのNext.jsアプリにConnected モードを追加する

```text wrap
Add Uncage Connected Mode to this Next.js (App Router) app for Vercel (FaaS mode), following https://uncage-dev.vercel.app/docs/deploy/vercel.md exactly.
Read https://uncage-dev.vercel.app/docs/skills/uncage/SKILL.md first and follow its rules.
1. npm i @uncage/hub @uncage/react-ui pg zod and npm i -D @types/pg.
2. Create lib/auth.ts, lib/uncage-hub.ts, app/api/uncage/[...path]/route.ts (toNextHandlers with waitUntil: after, maxDuration 300, dynamic 'force-dynamic', runtime 'nodejs'), app/uncage/page.tsx, app/device/page.tsx, app/device/actions.ts, app/device/approve-page.tsx, next.config.ts headers and vercel.json (the maintenance cron), as on that page.
3. Wire lib/auth.ts to this app's existing sign-in. Do not keep the development user unless the app has no sign-in at all.
4. Do not add a custom server, WebSocket code or @uncage/hub/node imports: on Vercel the hub runs in the route handler and needs only Postgres.
Verify: with a local Postgres in DATABASE_URL, run next build && next start, then curl -s http://localhost:3000/api/uncage/agent/info shows a single "http" transport, and curl -sI http://localhost:3000/device shows Content-Security-Policy: frame-ancestors 'none'. List the environment variables to set on Vercel (DATABASE_URL, PUBLIC_URL, CRON_SECRET). Report what you changed.
```

### Next.jsアプリにLocal モードを追加する

```text wrap
Add Uncage Local Mode to this Next.js (App Router) app, following https://uncage-dev.vercel.app/docs/start/quickstart-local.md exactly.
1. npm i @uncage/server @uncage/react-ui @uncage/cli
2. Create app/api/uncage/[...path]/route.ts with createUncageHandler from @uncage/server/proxy (runtime 'nodejs', dynamic 'force-dynamic', export GET, POST, PATCH).
3. Create a page that renders <UncageProvider><AgentChat /></UncageProvider> from @uncage/react-ui inside a full-height container, and import '@uncage/react-ui/styles.css'.
Do not expose the daemon token to the browser and do not call the daemon from client code directly.
Verify: run "npx uncage doctor" and report each line; with "npx uncage serve --workspace <this repo>" running in another terminal and the app on http://localhost:3000, curl -s http://localhost:3000/api/uncage/runtimes returns a JSON array that contains "claude".
```

### 自社の機能をサイトツールとして公開する

```text wrap
Expose <feature, e.g. "create an invoice draft"> to Uncage as a site tool.
Read https://uncage-dev.vercel.app/docs/guides/define-tools.md first.
Use defineTool from @uncage/hub with a zod input schema and a description written for the model. Check ownership with ctx.user.id inside the handler. Throw only user-safe messages. Set requiresConfirmation: true if the tool changes or publishes anything.
Add it to the hub's tools option and, if this app uses selectManifest, to the runs that need it. Add a unit test that calls the handler with a fake ctx.
```

### ハブを複数ノードに移行する

```text wrap
Make our Uncage hub run on several nodes, following https://uncage-dev.vercel.app/docs/guides/multi-node.md.
Use postgresHubStore with DATABASE_URL, and redisCluster with REDIS_URL (or postgresCluster on the same pool if we have no Redis); attach 'error' listeners to any pool or client we create ourselves; make sure the load balancer passes WebSocket upgrades on /api/uncage/agent and does not buffer streams; configure the client IP for rate limits.
```

### Uncage 0.2からアップグレードする

```text wrap
Upgrade this project's Uncage packages from 0.2 to 0.3, following https://uncage-dev.vercel.app/docs/reference/migrate-from-0-2.md.
Update every @uncage/* package together. Import toNodeHandler, attachWebSocket and pgliteHubStore from @uncage/hub/node; replace hub.attach(server) with attachWebSocket(hub, server) and hub.handler with hub.fetch; pass an explicit store to createHub (pgliteHubStore with the data folder we used before, default ./.uncage-hub, so paired computers carry over) and close it after hub.close().
Verify: the project type-checks and builds, and curl -s http://localhost:3000/api/uncage/agent/info shows "protocol":2.
```

## エージェント向けの経験則

- **マウント方法はプラットフォームで選ぶ**。常駐するNodeサーバーなら、`@uncage/hub/node`の`toNodeHandler(hub)` + `attachWebSocket(hub, server)` + `pgliteHubStore`。VercelのNext.jsなら、`toNextHandlers(getHub, { waitUntil: after })` + `postgresHubStore` + `postgresCluster`で、カスタムサーバーは使いません。Cloudflare Workersなら、リクエストごとのプールを使う`fetchOnce`。その他のFetch対応の環境なら、`hub.fetch(req, { clientIp, waitUntil })`。サーバーレスやWorkerのコードで`@uncage/hub/node`をインポートしてはいけません。それぞれのトレードオフは[デプロイモードを選ぶ](/docs/ja/start/choose-deployment-mode/)で説明しています。
- **名前は正確に**。APIの名前は、このサイトに書かれているとおりに使ってください（`createHub`、`defineTool`、`toNodeHandler`、`attachWebSocket`、`toNextHandlers`、`fetchOnce`、`hub.fetch`、`selectManifest`、`sessionStorage`、`ctx.files.pull`）。すべての用語は[用語集](/docs/ja/reference/glossary/)で定義されており、すべてのシグネチャは[自動生成されたAPIリファレンス](/docs/api/hub/)（英語）に載っています。
- **コーディングエージェントを選ぶのはユーザー**。ウェブサイトが使えるのは、ユーザーのコンピュータが提供するランタイムです。Claude Code、Codex、そして[ACPエージェント](/docs/ja/guides/use-any-acp-agent/)（ACPレジストリをもとに検出され、ハンドシェイクの後に有効になり、`npx`/`uvx`から実行されるものはユーザーが`uncage runtimes enable`を実行した後にだけ動きます）があります。ランタイムピッカーで選べる場面で、ランタイムIDをハードコードしないでください。
- **コードサンプルはコンパイルできます**。このサイトのTypeScriptサンプルはすべて、CIで最新のパッケージに対して型チェックされています。サンプルのタイトルに書かれたファイル（`lib/tools.ts`）は相対パスで互いをインポートします。表示されていないモジュール（アプリの`./auth`など）は、あなたが書くものです。
- **ウェブサイトからユーザーのコンピュータでシェルコマンドを実行する手段は、決して追加しないでください**。また、ウェブサイトから`bypassPermissions`を有効にしようとしないでください。Uncageは設計上、どちらも拒否します（[トラストモデル](/docs/ja/concepts/trust-model/)）。
- **推測せず、確認する**。組み込みを終えたら、スキルとクイックスタートにある検証コマンドを実行し、その出力をレポートに含めてください。
