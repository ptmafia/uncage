---
title: 认证与设备授权
description: 用 getUser 把 hub 接入你的登录体系，并安全地实现 /device 审批页（仅限已登录用户、frame-ancestors 'none'、带 CSRF 防护的 POST），适用于 Next.js 或任何 Node 服务器。
---

hub 自己没有账号体系。它向你的网站询问当前登录的是谁，并通过你网站的审批页把一台电脑关联到这个人。

## `getUser(req)`

`getUser` 以 Fetch `Request` 的形式接收每个发往 hub 的浏览器请求，返回已登录用户或 `null`：

```ts nocheck
getUser(req: Request): Promise<{ id: string; name?: string } | null>
```

- `id` 必须稳定，且每个用户唯一：hub 以它为键保存电脑、会话和工具调用记录，并以 `ctx.user.id` 的形式传给你的工具 handler。
- `name` 可选，用于显示。
- 返回 `null` 会让请求以 `401 unauthorized` 失败。CLI 使用的设备端点（`/device/code`、`/device/token`、`/machine/revoke`）和 `install.sh` 是公开的，从不调用 `getUser`。
- 它在每个请求上都会运行（包括每条 SSE 连接），所以要快：校验签名 cookie，或查询带缓存的会话。

### 从会话 cookie 读取

大多数登录库会把会话 id 或签名令牌存在 cookie 里。从 `Cookie` 请求头读取它：

```ts title="auth.ts"
import type { HubUser } from '@uncage/hub';

/** Your session store: session id → user. */
declare function findSession(sessionId: string): Promise<{ userId: string; displayName: string } | null>;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export async function getUser(req: Request): Promise<HubUser | null> {
  const sid = readCookie(req, 'session_id');
  if (!sid) return null;
  const session = await findSession(sid);
  return session ? { id: session.userId, name: session.displayName } : null;
}
```

如果你的库提供了接受 Fetch `Request` 的辅助函数（很多都有），直接调用即可。`examples/connected-demo` 应用使用 HMAC 签名的 cookie，见它的 `lib/auth.ts`。

### Cookie 与 CSRF

浏览器 API 依靠你的 cookie 认证，所以 hub 会防范跨站请求：非 GET 请求的 `Origin` 既不是 `publicUrl` 也不是请求自身的主机，或者带有 `Sec-Fetch-Site: cross-site` 标记时，会得到 `403 forbidden_origin`。同时请让你的会话 cookie 保持 `SameSite=Lax`（或 `Strict`）和 `Secure`。

## 审批页（`/device`）

`uncage setup https://your.site` 会打开 `https://your.site/device?code=ABCD-2345`。路径可以用 `verificationPath` 选项修改。已登录用户在这个页面上批准或拒绝这个验证码。**批准就等于让那台电脑访问该用户的账号**，所以这个页面是点击劫持和 CSRF 的攻击目标。它必须：

1. **要求正常的登录会话。** 用户未登录时，把他带到你的登录页，登录后再回来。
2. **禁止被嵌入框架：** `Content-Security-Policy: frame-ancestors 'none'` 和 `X-Frame-Options: DENY`。
3. **用带 CSRF 防护的 POST 做决定。** 绝不要通过 GET 批准，也不要仅凭链接本身就批准。
4. **展示正在批准的内容：** 验证码（用户拿它和终端里的对照），以及 `hub.lookupDevice` 返回的电脑名称和操作系统。

hub 提供三个调用，每个都接收验证码和已登录用户：

| 调用 | 返回 |
| --- | --- |
| `hub.lookupDevice(code, user)` | 验证码待处理时返回 `{ name?, os?, expiresAt, repairsMachine }`，否则返回 `null`。如果批准会重新配对该用户的某台电脑，则设置 `repairsMachine`：那台电脑保留原来的 id 和会话，旧令牌失效。 |
| `hub.approveDevice(code, user)` | `'ok'`、`'not_found'` 或 `'expired'` |
| `hub.denyDevice(code, user)` | `'ok'`、`'not_found'` 或 `'expired'` |

验证码由 `ABCDEFGHJKMNPQRSTUVWXYZ23456789` 中的 8 个字符组成，显示为 `ABCD-2345`，10 分钟内有效。大小写、空格和短横线都会被忽略。未知的验证码算作猜错：10 分钟内猜错 10 次后（`rateLimits.userCodeFailures`、`userCodeWindowMs`），这些调用会抛出 `code: 'rate_limited'` 的错误（`details.retryAfterSec`）。

`@uncage/react-ui` 里的 `<ApproveDevice>` 负责渲染这个页面：码、电脑、重新配对警告、批准和拒绝按钮，以及结果。它只负责展示；决定在服务器上做。把失败调用的错误传给它的 `error` 属性：错误会以本地化文字显示（`rate_limited` 时为“请求太频繁了，稍等一下再试。”）；有查询结果时显示在按钮上方，`lookupDevice` 本身失败、`lookup` 为 `null` 时则替代“验证码无效或已过期”的提示。

### Next.js

[Connected 模式快速上手](/docs/zh-cn/start/quickstart-connected/#7-审批页)里有完整的 Next.js 版本：一个调用 `lookupDevice` 的服务端组件，一个调用 `approveDevice` / `denyDevice` 的 Server Action（Server Action 只接受 POST，而且 Next.js 会检查它的 `Origin`，这就是 CSRF 防护），一个包裹 `<ApproveDevice>` 的客户端组件，以及 `next.config.ts` 里的响应头。同样的写法、加上真实的登录跳转，见 `examples/connected-demo/app/device/`。

只给审批页加响应头：

```ts title="next.config.ts"
import type { NextConfig } from 'next';

const config: NextConfig = {
  async headers() {
    return [
      {
        source: '/device',
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

### Express（任何 Node 服务器）

没有 Server Action 时，写两个小端点，自己检查源。下面是一个完整的服务器（`getUser` 就是[上文](#从会话-cookie-读取)那个）；页面本身可以是任何渲染 `<ApproveDevice>`、并用 `fetch` 调用这些端点的 React 页面。

```ts title="server.ts"
import { createServer } from 'node:http';
import { createHub, toNodeHandler, type HubUser } from '@uncage/hub';
import express, { type NextFunction, type Request as ExpressRequest, type Response } from 'express';
import { getUser } from './auth.ts';

const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:3000';
const hub = await createHub({ publicUrl: PUBLIC_URL, getUser });

/** Your sign-in for Express requests (the same session as getUser). */
declare function userOf(req: ExpressRequest): Promise<HubUser | null>;

const app = express();
app.use(toNodeHandler(hub));
app.use(express.json());

// Never framed.
app.use('/device', (_req: ExpressRequest, res: Response, next: NextFunction) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

/** CSRF: state-changing requests must come from this site. */
function sameOrigin(req: ExpressRequest): boolean {
  const origin = req.get('origin');
  if (origin) return origin === new URL(PUBLIC_URL).origin;
  return req.get('sec-fetch-site') === 'same-origin';
}

app.get('/device/lookup', async (req, res) => {
  const user = await userOf(req);
  if (!user) return void res.status(401).json({ code: 'unauthorized' });
  const code = String(req.query.code ?? '');
  try {
    res.json({ lookup: code ? await hub.lookupDevice(code, user) : null });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    res.status(err.code === 'rate_limited' ? 429 : 500).json({ code: err.code ?? 'internal_error', message: err.message });
  }
});

app.post('/device/decision', async (req, res) => {
  if (!sameOrigin(req)) return void res.status(403).json({ code: 'forbidden_origin' });
  const user = await userOf(req);
  if (!user) return void res.status(401).json({ code: 'unauthorized' });
  const { code, approve } = req.body as { code?: unknown; approve?: unknown };
  if (typeof code !== 'string' || typeof approve !== 'boolean') return void res.status(400).json({ code: 'invalid_request' });
  try {
    const result = approve ? await hub.approveDevice(code, user) : await hub.denyDevice(code, user);
    res.json({ result }); // 'ok' | 'not_found' | 'expired'
  } catch (e) {
    const err = e as { code?: string; message?: string };
    res.status(err.code === 'rate_limited' ? 429 : 500).json({ code: err.code ?? 'internal_error', message: err.message });
  }
});

const server = createServer(app);
hub.attach(server);
server.listen(3000);
```

在页面上调用 `GET /device/lookup?code=…`，渲染 `<ApproveDevice code lookup state error onApprove onDeny />`，再用 `{ code, approve }` 调用 `POST /device/decision`（浏览器在 `fetch` 发起的 POST 上会带 `Origin`）。把返回结果映射到 `ApproveDevice` 的 `state`：`'ok'` → `'approved'` 或 `'denied'`；`'not_found'` 和 `'expired'` 原样传入；错误交给它的 `error` 属性（按钮保持可用，方便重试；`lookup: null` 时错误会替代“找不到验证码”的提示）。

## 吊销电脑

- **从你的网站：** `<AgentChat>` 的电脑菜单列出了该用户的电脑。在你自己的界面里，使用 `useMachines().revoke(id)` 或 `DELETE <basePath>/machines/:id`。在服务器上：`await hub.revokeMachine(machineId, user)`（对别人的或不存在的 id 抛出 `machine_not_found`）。
- **从电脑上：** `uncage sites remove <site id>` 用电脑自己的令牌在网站上吊销它，并删除本地令牌。

无论哪种方式，令牌都会立即失效，电脑随即断开。它的会话仍保留在你的存储里（以及电脑上）。
