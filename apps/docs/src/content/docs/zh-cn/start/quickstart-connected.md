---
title: 快速上手：Connected 模式
description: 把 Uncage 接进一个 Next.js 应用，让已登录的用户连接自己的电脑，在你的网站上指挥他们自己的 Claude Code，并调用你的一个网站工具。约 15 分钟。
---

读完这一页，你会得到：

- 你的 Next.js 应用在 `/api/uncage` 提供 Uncage hub；
- 一个页面显示 `<AgentChat>`，一开始会提示“连接你的电脑”；
- 用户在 `/device` 批准自己的电脑；
- 用户电脑上的 Claude Code 可以调用你的一个工具 `save_note`，它在你的服务器上以该用户身份运行。

你会先后扮演两个角色：网站开发者，然后是连接电脑的用户。

## 复制给你的 coding agent 的提示词

如果你在用 Claude Code、Codex 或其他 coding agent，可以把下面这段直接贴给它，代替手动操作：

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

## 开始之前

- **网站一侧：** 一个用 Node 运行的 Next.js 16 应用（App Router）。Node.js **22.18 或更高**，因为下面的自定义服务器是一个由 Node 直接运行的 `.ts` 文件。从零开始：`npx create-next-app@latest my-site`（选 TypeScript、App Router）。
- **用户一侧（这次测试就是你自己的电脑）：** Node.js 22+（下面的安装脚本可以帮你装好），并且已安装并登录 Claude Code：`npm i -g @anthropic-ai/claude-code`，然后运行一次 `claude` 并输入 `/login`。系统为 macOS、Linux 或 Windows（macOS 已在真机上验证；Linux 和 Windows 已通过 CI 验证，尚待真机确认）。

:::note[为什么需要自定义服务器]
本快速上手使用**传统模式**：hub 和每台已连接的电脑各保持一条 WebSocket，并把数据存在一个嵌入式数据库目录里，所以不需要任何其他东西。这需要一个长期运行、能接触到 HTTP 服务器的 Node 进程，而单靠 Next.js 的 route handler 做不到。要部署到 **Vercel** 或其他 Serverless 平台？请看 [Vercel 上的 Next.js](/docs/zh-cn/deploy/vercel/)（一个 route handler 加 Postgres，不需要自定义服务器）。该选哪种：见[选择部署模式](/docs/zh-cn/start/choose-deployment-mode/)。
:::

## 1. 安装

```sh
npm i @uncage/hub @uncage/react-ui zod
```

## 2. 识别当前登录用户

hub 在每个浏览器请求上都会问你的应用：当前用户是谁。这个快速上手里先用一个固定的开发用户。[认证指南](/docs/zh-cn/guides/auth-and-device-approval/)介绍如何接入真正的登录。

```ts title="lib/auth.ts"
import type { HubUser } from '@uncage/hub';

/**
 * Replace both functions with your real sign-in before you deploy.
 * `userFromRequest` is used by the hub (a Fetch `Request`); `currentUser` by your pages.
 */
export async function userFromRequest(_req: Request): Promise<HubUser | null> {
  return developmentUser();
}

export async function currentUser(): Promise<HubUser | null> {
  return developmentUser();
}

function developmentUser(): HubUser {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('lib/auth.ts still returns the development user: connect it to your sign-in.');
  }
  return { id: 'dev-user', name: 'Developer' };
}
```

## 3. 定义一个工具

网站工具是你网站的一项能力，Claude Code 可以调用它。它的 handler **在你的服务器上运行**，身份是会话所属的用户。用户电脑只会收到名称、描述，以及由 `input` 生成的 JSON Schema。

```ts title="lib/tools.ts"
import { defineTool, type SiteTool } from '@uncage/hub';
import { z } from 'zod';

/** Stand-in for your database. */
// Kept on globalThis: server.ts and Next.js pages load separate copies of this module,
// so a plain module-level Map would look empty from a page that lists the notes.
type Notes = Map<string, Array<{ id: string; title: string; text: string }>>;
const g = globalThis as typeof globalThis & { __demoNotes?: Notes };
const notes: Notes = (g.__demoNotes ??= new Map());

export const saveNote = defineTool({
  name: 'save_note',
  description: 'Save a note to the signed-in user’s notes on the website. Returns the note id.',
  input: z.object({
    title: z.string().min(1).max(120),
    text: z.string().min(1).max(10_000),
  }),
  handler: async ({ title, text }, ctx) => {
    const mine = notes.get(ctx.user.id) ?? [];
    const note = { id: `note_${mine.length + 1}`, title, text };
    notes.set(ctx.user.id, [...mine, note]);
    return { saved: note.id };
  },
});

export const tools: SiteTool[] = [saveNote];
```

## 4. 创建 hub

hub 由你的自定义服务器创建一次。页面也需要用到它（审批页要调用它），但 Next.js 会单独打包页面代码，所以服务器通过 `globalThis` 把实例交出去。

```ts title="lib/uncage-hub.ts"
import { createHub, type Hub } from '@uncage/hub';
import { pgliteHubStore } from '@uncage/hub/node';
import { userFromRequest } from './auth.ts';
import { tools } from './tools.ts';

export async function createAppHub(): Promise<Hub> {
  return createHub({
    // The URL your users open. Also what `uncage setup <url>` is given.
    publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
    getUser: userFromRequest,
    // The hub's own database: embedded Postgres in this folder (computers, sessions, tool calls).
    store: await pgliteHubStore({ dataDir: './.uncage-hub' }),
    tools,
    // Keep a copy of every conversation on the website (readable while the computer is off).
    sessionStorage: 'site',
  });
}
```

```ts title="lib/hub-registry.ts"
import type { Hub } from '@uncage/hub';

const KEY = Symbol.for('my-site.uncage-hub');

/** Called once by server.ts. */
export function publishHub(hub: Hub): void {
  (globalThis as Record<symbol, unknown>)[KEY] = hub;
}

/** The hub server.ts created, for pages and Server Actions. */
export function getHub(): Hub {
  const hub = (globalThis as Record<symbol, unknown>)[KEY] as Hub | undefined;
  if (!hub) throw new Error('The Uncage hub is not running: start the app with `node server.ts`, not `next dev`.');
  return hub;
}
```

`pgliteHubStore` 把 hub 的数据存在 `./.uncage-hub`（内嵌 PGlite，每个目录只能由一个进程使用）。把这个目录加进 `.gitignore`，部署时把它放在持久磁盘上。

## 5. 自定义服务器

一个 Node HTTP 服务器承载全部内容：`/api/uncage` 下的 hub HTTP API、`/api/uncage/agent` 上电脑的 WebSocket，以及其他所有路径上的 Next.js 应用。`toNodeHandler` 和 `attachWebSocket` 来自 `@uncage/hub/node`，也就是 hub 中只能在 Node 上运行的部分。

```ts title="server.ts"
import { createServer } from 'node:http';
import { attachWebSocket, toNodeHandler } from '@uncage/hub/node';
import next from 'next';
import { publishHub } from './lib/hub-registry.ts';
import { createAppHub } from './lib/uncage-hub.ts';

const dev = process.env.NODE_ENV !== 'production';
// If you change PORT, also set PUBLIC_URL (lib/uncage-hub.ts) to the URL users open.
const port = Number(process.env.PORT ?? 3000);

const hub = await createAppHub();
publishHub(hub);
const hubHandler = toNodeHandler(hub);

const server = createServer();
const app = next({ dev, hostname: 'localhost', port, httpServer: server });
const handle = app.getRequestHandler();
await app.prepare();

server.on('request', (req, res) => {
  // Paths under /api/uncage go to the hub; everything else falls through to Next.js.
  hubHandler(req, res, () => void handle(req, res));
});

attachWebSocket(hub, server); // computers connect to ws(s)://<host>/api/uncage/agent

if (dev) {
  // Next.js hot reload uses WebSockets too; leave the hub's path to the hub.
  const upgrade = app.getUpgradeHandler();
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== `${hub.basePath}/agent`) void upgrade(req, socket, head);
  });
}

server.listen(port, () => console.log(`ready on http://localhost:${port}`));
```

用 Node 启动它，而不是 `next dev`。Node 会直接运行 `server.ts`（自动去掉类型），它导入的文件使用显式的 `.ts` 扩展名，所以：

```json title="package.json (excerpt)"
{
  "type": "module",
  "scripts": {
    "dev": "node server.ts",
    "build": "next build",
    "start": "NODE_ENV=production node server.ts"
  }
}
```

```json title="tsconfig.json (excerpt)"
{
  "compilerOptions": {
    "allowImportingTsExtensions": true
  }
}
```

## 6. 对话页面

`<AgentChat>` 默认请求 `/api/uncage`。它会发现对面是 hub（而不是本地的 Uncage 服务），自动切换到 Connected 模式：还没有电脑时，显示带一条安装命令的 `<ConnectMachine>`；连上之后，标题栏显示这段对话运行在哪台电脑上。

```tsx title="app/uncage/page.tsx"
'use client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

export default function UncagePage() {
  return (
    <div style={{ height: '100vh' }}>
      <UncageProvider>
        <AgentChat starterPrompts={['Write a short poem about this website and save it with save_note']} />
      </UncageProvider>
    </div>
  );
}
```

## 7. 审批页

`uncage setup` 会把用户带到你网站上的 `/device?code=…`。在这里批准，就等于让那台电脑访问该用户的账号，所以这个页面必须只对已登录用户开放、不能被嵌入框架，并且要用只有你自己的源才能发出的 POST 记录决定。Next.js 的 Server Action 只接受 POST 并会检查 `Origin`，正好满足最后一点。

```tsx title="app/device/page.tsx"
import type { ApproveDeviceProps } from '@uncage/react-ui';
import { currentUser } from '../../lib/auth.ts';
import { getHub } from '../../lib/hub-registry.ts';
import { ApprovePage } from './approve-page.tsx';

export const dynamic = 'force-dynamic';

type DeviceError = NonNullable<ApproveDeviceProps['error']>;

export default async function DevicePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code = '' } = await searchParams;
  const user = await currentUser();
  if (!user) return <p>Sign in first, then open this link again.</p>; // or redirect to your login page
  let lookup: ApproveDeviceProps['lookup'] = null;
  let error: DeviceError | undefined;
  try {
    lookup = code ? await getHub().lookupDevice(code, user) : null;
  } catch (e) {
    // Unknown codes count as failed guesses; after 10 in 10 minutes lookupDevice throws `rate_limited`.
    // <ApproveDevice> shows the error, localized, in place of "code not found".
    const err = e as { code?: string; message?: string };
    error = { code: err.code === 'rate_limited' ? 'rate_limited' : 'internal_error', message: err.message ?? 'Could not check this code.' };
  }
  return <ApprovePage code={code} lookup={lookup} initialError={error} />;
}
```

```ts title="app/device/actions.ts"
'use server';
import { currentUser } from '../../lib/auth.ts';
import { getHub } from '../../lib/hub-registry.ts';

export type DecideResult = { result: 'ok' | 'not_found' | 'expired' } | { error: { code: string; message: string } };

/** A Server Action: a POST that Next.js only accepts from this site's own Origin. */
export async function decide(code: string, approve: boolean): Promise<DecideResult> {
  const user = await currentUser();
  if (!user) return { error: { code: 'unauthorized', message: 'Sign in again.' } };
  try {
    const hub = getHub();
    return { result: await (approve ? hub.approveDevice(code, user) : hub.denyDevice(code, user)) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { error: { code: err.code ?? 'internal_error', message: err.message ?? 'Failed' } };
  }
}
```

```tsx title="app/device/approve-page.tsx"
'use client';
import { ApproveDevice, type ApproveDeviceProps, type ApproveDeviceState } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';
import { useState } from 'react';
import { decide } from './actions.ts';

export function ApprovePage({
  code,
  lookup,
  initialError,
}: Pick<ApproveDeviceProps, 'code' | 'lookup'> & { initialError?: ApproveDeviceProps['error'] }) {
  const [state, setState] = useState<ApproveDeviceState>('idle');
  const [error, setError] = useState<ApproveDeviceProps['error']>(initialError);
  const act = async (approve: boolean) => {
    setState(approve ? 'approving' : 'denying');
    setError(undefined);
    const r = await decide(code, approve);
    if ('error' in r) {
      setState('idle'); // the buttons stay enabled for a retry
      setError(r.error as ApproveDeviceProps['error']);
    } else {
      setState(r.result === 'ok' ? (approve ? 'approved' : 'denied') : r.result);
    }
  };
  return <ApproveDevice code={code} lookup={lookup} state={state} error={error} onApprove={() => void act(true)} onDeny={() => void act(false)} />;
}
```

禁止审批页（最简单的做法是所有页面）被嵌入框架：

:::caution[整个替换这个文件]
较新的 `create-next-app` 模板会在 `next.config.ts` 里加上 `cacheComponents: true`，它和 `/device` 页面上的 `export const dynamic = 'force-dynamic'` 冲突（`next build` 会报“Route segment config "dynamic" is not compatible with `nextConfig.cacheComponents`”）。请用下面的文件整个替换生成的文件，不要合并。
:::

```ts title="next.config.ts"
import type { NextConfig } from 'next';

const config: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
```

## 8. 启动网站

```sh
npm run dev
```

确认 hub 有响应：

```sh
curl -s http://localhost:3000/api/uncage/install.sh | head -3
```

它会打印安装脚本的开头（`#!/usr/bin/env bash`、`# Uncage installer: …`）。

## 9. 连接你的电脑（用户一侧）

打开 `http://localhost:3000/uncage`。对话框显示 **Connect your computer**（连接你的电脑）和一条命令，默认打开你的操作系统对应的标签页。真实部署时用户会复制这条命令；本地测试时：

1. **运行这条命令。** 在 macOS 或 Linux 上运行 `curl -fsSL http://localhost:3000/api/uncage/install.sh | bash`；在 Windows（PowerShell）上运行 `irm http://localhost:3000/api/uncage/install.ps1 | iex`。安装脚本会先检查电脑（Node.js 22+、npm、coding agent），在每个需要执行的步骤之前询问 `[Y/n]`（如果你有 Node 版本管理器就用它；绝不使用 `sudo` 或管理员权限），安装 `@uncage/cli`，并询问是否替你运行 `uncage setup http://localhost:3000`：回答 **Y**。它在各操作系统上做了什么，见[在你的电脑上安装](/docs/zh-cn/start/install-on-your-computer/)。
2. **已经装好 CLI**（`npm i -g @uncage/cli`）？那就改为运行页面上 **Already have the CLI?**（已经装好 CLI？）下面显示的 setup 命令：

   ```sh
   uncage setup http://localhost:3000
   ```

3. **批准。** setup 会打印一个验证码，并打开 `http://localhost:3000/device?code=…`。确认验证码一致后点击 **Approve**（批准）。setup 会把机器令牌存到 `~/.uncage/agent.yaml`，并启动后台守护进程（按用户运行的服务：macOS 上是 launchd，Linux 上是 systemd，Windows 上是计划任务；用 `uncage agent status` 可以查看）。

回到对话页，状态从“Waiting for your computer…”（等待你的电脑上线…）变为 **Connected: &lt;你的电脑名&gt;**（已连接）。

:::tip[纯 http]
守护进程只对 `localhost` 和 `127.0.0.1` 接受 `http://`。其他网站都必须用 `https://`（WebSocket 随之使用 `wss://`）。
:::

## 10. 发一个任务

点击示例提示词，或者输入：“Write a short poem about this website and save it with save_note”。

- Claude Code 在你的电脑上、在 `~/Uncage/localhost-3000/<session id>/` 里运行。
- 它调用 `mcp__site__save_note`，handler 以 `dev-user` 身份在你的 Next.js 服务器里运行。
- 回答以流式显示在对话框里。执行命令和修改文件会弹出审批卡片，按钮是 **Allow once**（允许执行）/ **Deny**（拒绝）。

停掉守护进程（`uncage agent uninstall`；如果你是在前台运行的 `uncage agent`，直接退出它），再刷新页面：因为配置了 `sessionStorage: 'site'`，对话仍然都在（地址栏保留 `?session=…`，左侧会话列表里也能找到），输入框提示电脑离线。

## 你做了什么

| 文件 | 作用 |
| --- | --- |
| `lib/auth.ts` | 当前登录用户（换成你的登录体系） |
| `lib/tools.ts` | 你的网站工具 |
| `lib/uncage-hub.ts`、`lib/hub-registry.ts` | 创建 hub，并共享给页面 |
| `server.ts` | 一个 HTTP 服务器：hub API、电脑的 WebSocket、Next.js |
| `app/uncage/page.tsx` | 对话页 |
| `app/device/*`、`next.config.ts` | 安全的审批页 |

仓库里的 [`examples/connected-demo`](https://github.com/ptmafia/uncage/tree/main/examples/connected-demo) 是同样的结构扩展成的完整网站：登录、两个创建并发布落地页的工具（从用户电脑拉取文件）、一个技能、资产展示页，以及基于 Redis 和 Postgres 的双节点模式。它用真实的 Claude Code 做过端到端测试。

## 下一步

- [定义网站工具](/docs/zh-cn/guides/define-tools/)：参数校验、错误、确认、文件通道。
- [编写技能](/docs/zh-cn/guides/write-skills/)，并[按运行选择它们](/docs/zh-cn/guides/select-manifest/)。
- [认证与设备授权](/docs/zh-cn/guides/auth-and-device-approval/)：接入你真正的登录。
- [部署](/docs/zh-cn/deploy/node/)：放到服务器上（传统模式），或者迁到 [Vercel](/docs/zh-cn/deploy/vercel/)（FaaS 模式）。
- [多节点](/docs/zh-cn/guides/multi-node/)：负载均衡后面的 Postgres + Redis。
- **部署到代理后面之前：** 设置客户端 IP（`trust proxy` 或 `rateLimits.clientIp`），否则所有用户共用一个 `uncage setup` 限流桶。见[反向代理或负载均衡之后](/docs/zh-cn/guides/mount-the-hub/#反向代理或负载均衡之后)。
