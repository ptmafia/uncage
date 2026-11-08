---
title: 面向 coding agent
description: Claude Code、Codex 等 coding agent 应该如何阅读本站、要安装哪个技能，以及可直接粘贴的 Uncage 集成提示词。
---

本站既写给人看，也写给 coding agent 读。下面列出的内容都是 agent 可以直接抓取的纯文本。

## 交给 agent 什么

| 资源 | URL | 用途 |
| --- | --- | --- |
| Uncage 技能 | [`/skills/uncage/SKILL.md`](/docs/skills/uncage/SKILL.md) | “把 Uncage 集成进一个网站”：什么情况用哪种模式、具体步骤、验证命令、常见陷阱。可以安装为技能，也可以把它的 URL 贴进提示词。 |
| 索引 | [`/llms.txt`](/docs/llms.txt) | 每个页面一行，附 Markdown 版本的 URL（[llmstxt.org](https://llmstxt.org) 格式）。 |
| 全部内容 | [`/llms-full.txt`](/docs/llms-full.txt) | 按阅读顺序把所有指南页合成一个 Markdown 文件（自动生成的 API 参考只给链接，不包含正文）。 |
| 任意页面 | 在网址后面加 `.md` | 例如 `https://uncage.vercel.app/docs/guides/define-tools.md`。每个页面顶部的 **本页 Markdown** 链接就指向这里。 |

Markdown 版本里的链接指向其他页面的 Markdown 版本，agent 不用解析 HTML 就能顺着读下去。

### 安装技能

使用 Claude Code 时，把它放进你的项目（或者放进 `~/.claude/skills/`，对所有项目生效）：

```sh
mkdir -p .claude/skills/uncage
curl -fsSL https://uncage.vercel.app/docs/skills/uncage/SKILL.md -o .claude/skills/uncage/SKILL.md
```

同一个文件也在仓库里：[`skills/uncage/SKILL.md`](https://github.com/ptmafia/uncage/blob/main/skills/uncage/SKILL.md)。

## 提示词

每篇快速上手都以一段**复制给你的 coding agent 的提示词**开头。这里把它们放在一起，另外加上几个常见的后续任务。

### 为这个项目选择集成方式

还不确定网站会运行在哪里时，先用这一段。技能会告诉 agent 每个平台该按哪一页来做。

```text wrap
Add Uncage Connected Mode to this website. Read https://uncage.vercel.app/docs/skills/uncage/SKILL.md and https://uncage.vercel.app/docs/start/choose-deployment-mode.md first.
Find out where this site runs (package.json scripts, vercel.json, wrangler.toml, netlify.toml, Dockerfile, Procfile, the hosting docs in the repo) and tell me which deployment mode fits and why:
- a long-running Node server or container → traditional mode, https://uncage.vercel.app/docs/deploy/node.md (or the Next.js custom server in https://uncage.vercel.app/docs/start/quickstart-connected.md);
- Next.js on Vercel → FaaS mode, https://uncage.vercel.app/docs/deploy/vercel.md;
- Cloudflare Workers → FaaS mode, https://uncage.vercel.app/docs/deploy/cloudflare-workers.md;
- another Fetch platform → FaaS mode, https://uncage.vercel.app/docs/deploy/other-fetch-platforms.md.
Then follow that page exactly, wire getUser to this app's existing sign-in, and run every item of its Verify checklist that can run locally. Report the mode you chose, the files you changed, the checklist output, and which environment variables I must set before deploying.
```

### 给 Next.js 应用加上 Connected 模式

和 [Connected 模式快速上手](/docs/zh-cn/start/quickstart-connected/#复制给你的-coding-agent-的提示词)里的提示词相同：

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

### 给部署在 Vercel 上的 Next.js 应用加上 Connected 模式

```text wrap
Add Uncage Connected Mode to this Next.js (App Router) app for Vercel (FaaS mode), following https://uncage.vercel.app/docs/deploy/vercel.md exactly.
Read https://uncage.vercel.app/docs/skills/uncage/SKILL.md first and follow its rules.
1. npm i @uncage/hub @uncage/react-ui pg zod and npm i -D @types/pg.
2. Create lib/auth.ts, lib/uncage-hub.ts, app/api/uncage/[...path]/route.ts (toNextHandlers with waitUntil: after, maxDuration 300, dynamic 'force-dynamic', runtime 'nodejs'), app/uncage/page.tsx, app/device/page.tsx, app/device/actions.ts, app/device/approve-page.tsx, next.config.ts headers and vercel.json (the maintenance cron), as on that page.
3. Wire lib/auth.ts to this app's existing sign-in. Do not keep the development user unless the app has no sign-in at all.
4. Do not add a custom server, WebSocket code or @uncage/hub/node imports: on Vercel the hub runs in the route handler and needs only Postgres.
Verify: with a local Postgres in DATABASE_URL, run next build && next start, then curl -s http://localhost:3000/api/uncage/agent/info shows a single "http" transport, and curl -sI http://localhost:3000/device shows Content-Security-Policy: frame-ancestors 'none'. List the environment variables to set on Vercel (DATABASE_URL, PUBLIC_URL, CRON_SECRET). Report what you changed.
```

### 给 Next.js 应用加上 Local 模式

```text wrap
Add Uncage Local Mode to this Next.js (App Router) app, following https://uncage.vercel.app/docs/start/quickstart-local.md exactly.
1. npm i @uncage/server @uncage/react-ui @uncage/cli
2. Create app/api/uncage/[...path]/route.ts with createUncageHandler from @uncage/server/proxy (runtime 'nodejs', dynamic 'force-dynamic', export GET, POST, PATCH).
3. Create a page that renders <UncageProvider><AgentChat /></UncageProvider> from @uncage/react-ui inside a full-height container, and import '@uncage/react-ui/styles.css'.
Do not expose the daemon token to the browser and do not call the daemon from client code directly.
Verify: run "npx uncage doctor" and report each line; with "npx uncage serve --workspace <this repo>" running in another terminal and the app on http://localhost:3000, curl -s http://localhost:3000/api/uncage/runtimes returns a JSON array that contains "claude".
```

### 把我们的某个功能开放为网站工具

```text wrap
Expose <feature, e.g. "create an invoice draft"> to Uncage as a site tool.
Read https://uncage.vercel.app/docs/guides/define-tools.md first.
Use defineTool from @uncage/hub with a zod input schema and a description written for the model. Check ownership with ctx.user.id inside the handler. Throw only user-safe messages. Set requiresConfirmation: true if the tool changes or publishes anything.
Add it to the hub's tools option and, if this app uses selectManifest, to the runs that need it. Add a unit test that calls the handler with a fake ctx.
```

### 把 hub 迁移到多个节点

```text wrap
Make our Uncage hub run on several nodes, following https://uncage.vercel.app/docs/guides/multi-node.md.
Use postgresHubStore with DATABASE_URL, and redisCluster with REDIS_URL (or postgresCluster on the same pool if we have no Redis); attach 'error' listeners to any pool or client we create ourselves; make sure the load balancer passes WebSocket upgrades on /api/uncage/agent and does not buffer streams; configure the client IP for rate limits.
```

### 从 Uncage 0.2 升级

```text wrap
Upgrade this project's Uncage packages from 0.2 to 0.3, following https://uncage.vercel.app/docs/reference/migrate-from-0-2.md.
Update every @uncage/* package together. Import toNodeHandler, attachWebSocket and pgliteHubStore from @uncage/hub/node; replace hub.attach(server) with attachWebSocket(hub, server) and hub.handler with hub.fetch; pass an explicit store to createHub (pgliteHubStore with the data folder we used before, default ./.uncage-hub, so paired computers carry over) and close it after hub.close().
Verify: the project type-checks and builds, and curl -s http://localhost:3000/api/uncage/agent/info shows "protocol":2.
```

## 给 agent 的经验法则

- **按平台选择挂载方式。** 长期运行的 Node 服务器：`@uncage/hub/node` 中的 `toNodeHandler(hub)` + `attachWebSocket(hub, server)` + `pgliteHubStore`。Vercel 上的 Next.js：`toNextHandlers(getHub, { waitUntil: after })` + `postgresHubStore` + `postgresCluster`，不需要自定义服务器。Cloudflare Workers：`fetchOnce` 配合按请求创建的连接池。其他支持 Fetch 的平台：`hub.fetch(req, { clientIp, waitUntil })`。绝不要在 Serverless 或 Worker 代码中导入 `@uncage/hub/node`。各自的取舍见[选择部署模式](/docs/zh-cn/start/choose-deployment-mode/)。
- **名称要一字不差。** API 名称严格按本站写法使用（`createHub`、`defineTool`、`toNodeHandler`、`attachWebSocket`、`toNextHandlers`、`fetchOnce`、`hub.fetch`、`selectManifest`、`sessionStorage`、`ctx.files.pull`）。[术语表](/docs/zh-cn/reference/glossary/)定义了每个术语；[自动生成的 API 参考](/docs/api/hub/)列出了每个签名。
- **coding agent 由用户选择。** 网站能用到的是用户电脑提供的运行时：Claude Code、Codex 和 [ACP agent](/docs/zh-cn/guides/use-any-acp-agent/)（从 ACP registry 发现，握手成功后启用；通过 `npx`/`uvx` 运行的，必须等用户执行 `uncage runtimes enable` 之后才会运行）。在运行时选择器可以选择的地方，不要把运行时 id 写死。
- **示例代码都能编译。** 本站的每段 TypeScript 示例都在 CI 里对照当前版本的包做过类型检查。示例标题里写明的文件（如 `lib/tools.ts`）之间用相对路径互相导入；没有展示的模块（比如你应用里的 `./auth`）需要你自己编写。
- **绝不要给网站加上在用户电脑上执行 shell 命令的途径**，也绝不要尝试从网站打开 `bypassPermissions`。Uncage 在设计上拒绝这两件事（见[信任模型](/docs/zh-cn/concepts/trust-model/)）。
- **要验证，不要假设。** 完成集成后，运行技能和快速上手里的验证命令，并把输出写进你的报告。
