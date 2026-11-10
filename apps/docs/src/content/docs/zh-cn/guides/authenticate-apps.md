---
title: "应用认证"
description: "移动应用或其他原生客户端如何登录你的 hub：你的 getUser 读取你签发的 Authorization Bearer 令牌，应用不发送 cookie 也不发送 Origin，而来自外部 Origin 的网站请求仍会被拒绝。"
---

hub 从不为用户签发凭据。对应用来说，`getUser(req)` 做的事和对网站一样：返回已登录用户，或返回 `null`。唯一的区别是去哪里找：读 `Authorization: Bearer <token>` 头，而不是 cookie。

## hub 如何处理应用请求

- **没有 `Origin` 头**的请求（所有原生 HTTP 栈）在每个浏览器 API 路由上都能通过跨站防护，包括会修改状态的路由。CSRF 是浏览器的问题：只有浏览器会在另一个网站发出的请求里带上 cookie，而浏览器在这种请求里总会发送 `Origin`。
- 带有**外部 `Origin`** 的请求（另一个网站上的网页）仍会以 `403 forbidden_origin` 被拒绝，即使带着有效的 cookie。
- 浏览器不会自己添加 Bearer 头，所以令牌不会被 CSRF 滥用。

因此：让 `getUser` 同时接受 cookie 和 Bearer 令牌，并且不要自己去信任 `Origin`。

## 用 Bearer 令牌实现 `getUser`

```ts title="auth.ts"
import type { HubUser } from '@uncage/hub';

/** Your token check: a signed token, an OAuth access token, a session id … → user or null. */
declare function userForToken(token: string): Promise<{ id: string; name: string } | null>;
/** Your cookie check (the web sign-in). */
declare function userForCookie(req: Request): Promise<{ id: string; name: string } | null>;

export async function getUser(req: Request): Promise<HubUser | null> {
  const header = req.headers.get('authorization');
  if (header !== null) {
    // A bearer header decides alone: an invalid token is never rescued by a cookie sent with it.
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return m ? await userForToken(m[1]!) : null;
  }
  return userForCookie(req);
}
```

用你已有的登录体系签发令牌（OAuth、你的会话系统、魔法链接）。给它设置过期时间和续期路由，在应用里存放到系统钥匙串（`expo-secure-store`），并通过客户端的异步 `headers` 选项发送（见 [React Native 应用](/docs/zh-cn/guides/react-native/)）。

## 演示里的令牌

`examples/connected-demo` 展示了最小实现，**仅用于演示**：

- `POST /api/app/token` 返回 `{ token, user, expiresAt }`。令牌形如 `uat1.<用户名>.<过期时间>.<hmac>`，有效期 30 天，签名密钥由 cookie 密钥加上独立的用途标签派生，所以 cookie 不会是有效的应用令牌，反过来也一样。它按以下顺序处理：有效 Bearer 令牌的续期（无效的返回 `401`）、已登录的 cookie 用户、在公开演示（`DEMO_PUBLIC=1`）里新建一个随机访客（每个客户端 IP 每分钟最多 10 个新访客，超过则返回带 `Retry-After` 的 `429`），否则使用请求体里的 `{ "username": "…" }`（没有密码：仅限演示）。
- 和所有会修改状态的路由一样，它会拒绝带外部 `Origin` 的请求。
- 真实的网站应该用自己的认证体系签发令牌，并像上面那样在 `getUser` 里验证。

## 检查清单

- [ ] 令牌是随机的或带签名，会过期，可以吊销；保存在钥匙串里，而不是普通存储。
- [ ] 对无效的 Bearer 令牌，`getUser` 返回 `null`，不会退回到 cookie。
- [ ] 令牌端点有限流，并拒绝外部 `Origin`。
- [ ] 不要在 `trustedOrigins` 里写 `null`、`file://` 或通配符：应用不需要它（[浏览器扩展](/docs/zh-cn/guides/browser-extension/)才需要）。

另见[认证与设备授权](/docs/zh-cn/guides/auth-and-device-approval/)和[安全](/docs/zh-cn/reference/security/)。
