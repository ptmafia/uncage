---
title: "浏览器扩展"
description: "把 agent 放进 Chrome Manifest V3 侧边栏：用站点 cookie 对着你的 hub 运行 AgentChat，为 chrome-extension://<id> 配置 trustedOrigins（仅限精确 origin），稳定的扩展 ID，cookie 与 SameSite 的注意事项，以及用 Bearer 令牌作为替代。"
---

浏览器扩展和其他客户端没有区别：侧边栏用 `@uncage/react-ui` 的 `<AgentChat>` 对着你的 hub 渲染。[`examples/connected-extension`](https://github.com/ptmafia/uncage/tree/main/examples/connected-extension) 是一个完整的、用 Vite 构建的 Chrome（Manifest V3）侧边栏。

:::note[状态]
已构建并测试：仓库里的 `extension-mock` 端到端项目会在 Chromium 中加载未打包的扩展，在演示站点登录，连接一个假的 agent，并从侧边栏运行一次会话。在你自己的 Chrome 配置文件里手动使用：等待确认。
:::

## 侧边栏

```tsx nocheck
import { createUncageClient } from '@uncage/client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';

const client = createUncageClient({
  baseUrl: `${HUB_ORIGIN}/api/uncage`,
  fetch: (url, init) => fetch(url, { ...init, credentials: 'include' }),
});

export const Panel = () => (
  <UncageProvider client={client}>
    <AgentChat />
  </UncageProvider>
);
```

扩展里没有登录界面。清单里对你站点 origin 的主机权限，加上 `credentials: 'include'`，会发送用户在**你站点的 cookie**，所以 `getUser` 看到的就是已经在那里登录的用户。如果不想依赖 cookie，可以改为发送 Bearer 令牌（`createUncageClient({ headers })`，见[应用认证](/docs/zh-cn/guides/authenticate-apps/)）。

## 告诉 hub 信任这个扩展

扩展的 origin `chrome-extension://<id>` 与你的站点不同源，所以 hub 的跨站防护会拒绝它会修改状态的请求。把它列出来：

```ts title="hub.ts"
import { createHub, type HubOptions } from '@uncage/hub';

declare const base: Omit<HubOptions, 'trustedOrigins'>;

export const hub = createHub({
  ...base,
  trustedOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
});
```

`trustedOrigins` 的规则（条目不合规时 `createHub` 会抛出错误）：

- 只接受精确的 origin：`scheme://host[:port]`，小写，不能有通配符、路径、查询、凭据或结尾的斜杠。把你发布的每个 ID 都列出来（商店版、开发版）。
- 允许的 scheme：`https`、`chrome-extension`、`moz-extension`、`safari-web-extension`，以及仅限 `localhost`、`127.0.0.1` 和 `[::1]` 的 `http`。`file:`、`data:`、`javascript:`、`blob:` 等一律拒绝。
- **只能是你自己掌控的 origin。** 受信任的 origin 可以携带用户的 cookie 发出会修改状态的请求。在那个扩展里运行的任何脚本都等同于用户本人，所以请像第一方应用那样发布它。
- 这不会削弱对网站的防护：其他所有外部 `Origin` 仍然会被拒绝。

在 `examples/connected-demo` 里，设置 `TRUSTED_ORIGINS=chrome-extension://<id>`（逗号分隔）。

## 扩展 ID

未打包扩展的 ID 取决于它的路径，除非 `manifest.json` 带有固定的公钥 `key`。示例带了一把一次性的密钥，所以开发期间它的 ID 是稳定的（`chrome-extension://bocaoaanfikfdhmnhipmjpkcepaioapj`）；在你自己的扩展里请删掉它。Chrome 网上应用店的构建由商店分配 ID：把那个 ID 写进 `trustedOrigins`。

## 构建与加载

```sh
HUB_ORIGIN=https://your.site pnpm --filter connected-extension build
```

`HUB_ORIGIN`（站点的 origin，不带路径）会成为清单里唯一的 `host_permissions` 项和侧边栏的 `baseUrl`。打开 `chrome://extensions`，打开开发者模式，点击**加载已解压的扩展程序**并选择 `dist` 文件夹；点击工具栏图标打开侧边栏。在同一个 Chrome 配置文件里登录站点，并连接一台电脑（[一键连接](/docs/zh-cn/guides/one-click-connect/)或 `uncage setup`）。

## Cookie 与 SameSite

Chrome 会把站点的 cookie 发送给持有主机权限的扩展页面，包括 `SameSite=Lax` 的 cookie。如果你的会话 cookie 是 `SameSite=Strict`，或者用户为你的站点屏蔽了第三方 cookie，侧边栏会显示未登录状态：请改用 Bearer 令牌。

另见[挂载 hub](/docs/zh-cn/guides/mount-the-hub/)和[安全](/docs/zh-cn/reference/security/)。
