---
title: "React Native 应用"
description: "在 Expo / React Native 应用里使用 @uncage/client 和 @uncage/react：用 expo/fetch 流式读取、Bearer 令牌请求头、保存当前会话的存储适配器、照片上传、应用从后台回来后恢复事件流，以及用手机批准一台新电脑。"
---

原生应用只是同一个 hub 的又一个入口。它只和**你的后端**（hub）通信，用你签发的 Bearer 令牌登录，像你的网站一样驱动用户自己的电脑。应用从不持有机器令牌，也从不直接连接电脑。

`@uncage/client` 和 `@uncage/react`（无界面的 hooks）无需修改即可在 React Native 中运行。它们不从 `react-native` 或 `expo-*` 导入任何东西；所有平台相关的部分都是由你的应用传入的适配器。这里没有 React Native UI 组件库：[`examples/connected-expo`](https://github.com/ptmafia/uncage/tree/main/examples/connected-expo) 演示了如何用这些 hooks 搭建界面，供你复制而不是安装。

:::note[状态]
已构建，并在模拟的 React Native 环境中做过单元测试（没有 `window.location`、没有 `localStorage`、没有 `EventSource`，使用可流式读取的 `fetch` 和异步请求头）。真机验证：尚未进行，等待真机确认。Expo Go 可以覆盖聊天、电脑列表、审批和照片；推送和应用链接需要开发构建（见[推送通知](/docs/zh-cn/guides/push-notifications/)）。
:::

## 1. hub 一侧

hub 为应用只需要两样东西：一个能识别你应用令牌的 `getUser`（见[应用认证](/docs/zh-cn/guides/authenticate-apps/)），以及可选的推送（见[推送通知](/docs/zh-cn/guides/push-notifications/)）。原生请求不带 `Origin` 头，所以 hub 的跨站防护会放行它们；来自其他网站的浏览器页面仍然会被拒绝。

## 2. 客户端

安装这些包，用可流式读取的 `fetch` 和你的令牌创建客户端：

```ts nocheck
import { createUncageClient } from '@uncage/client';
import { fetch as streamFetch } from 'expo/fetch';

export const client = createUncageClient({
  baseUrl: 'https://your.site/api/uncage',
  fetch: streamFetch,
  // Called for every request and every stream (re)connect; may be async (token refresh).
  headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
});
```

- **流式读取。** React Native 内置的 `fetch` 无法流式读取响应体，而客户端从 `response.body.getReader()` 读取事件。Expo 的 `expo/fetch` 支持流式。在裸 React Native 中，可以使用任何提供 `body.getReader()` 的 `fetch` polyfill。如果没有 `TextDecoder`（较旧的 Hermes），客户端会使用内置的小型 UTF-8 解码器。
- **上传。** `uploadAttachment` 接受浏览器的 `File`，也接受来自 `expo-image-picker` 的 `{ uri, name, type }` 对象。对于后者，客户端先用全局的 `fetch(uri)`读出文件，再通过你传入的 `fetch` 发送。在 Expo SDK 58 及更高版本中，全局 `fetch` 就是 `expo/fetch`（只有设置 `EXPO_PUBLIC_USE_RN_FETCH=1` 才是 React Native 自带的 `fetch`）。它能读取 `file://`，但**不能**读取 `content://`：`expo-image-picker` 已经交出 `file://` 副本，任何 `content://` URI 都必须先复制到缓存文件。`examples/connected-expo` 让事件流走 `expo/fetch`，其余请求走全局 `fetch`。`useAttachments().add()` 接受有名字的 `Blob`，而不是 `{ uri, name, type }`：先把选取的文件读成 `Blob` 并命名（见示例里的 `lib/attachments.ts`）。
- **图片。** `client.attachmentUrl(id)` 需要认证头，所以用 `<Image source={{ uri, headers }} />` 渲染。
- **异步请求头。** 如果 `headers()` 抛出错误（比如令牌刷新失败），请求会以 `unauthorized` 失败，并带有 `details.reason: 'headers'`；事件流通过 `onError` 报告并重试。

## 3. Hooks

用 `UncageProvider` 包住应用，像在网页里一样使用这些 hooks（`useMachines`、`useSession`、`useRuns`、`useApprovals` 等）。应用有三点特别之处：

```tsx nocheck
import { usePersistSession, useReconnect, type PersistSessionStorage } from '@uncage/react';
import * as SecureStore from 'expo-secure-store';
import { useEffect } from 'react';
import { AppState } from 'react-native';

const storage: PersistSessionStorage = {
  get: () => SecureStore.getItemAsync('uncage.session'),
  set: (id) => (id === undefined ? SecureStore.deleteItemAsync('uncage.session') : SecureStore.setItemAsync('uncage.session', id)),
};

export function useAppLifecycle() {
  usePersistSession(storage); // reopen the last conversation after a restart
  const reconnect = useReconnect();
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && reconnect());
    return () => sub.remove();
  }, [reconnect]);
}
```

- **`usePersistSession(storage)`** 接受一个 `{ get, set }` 适配器（同步或异步均可：AsyncStorage、SecureStore、MMKV）。使用默认的 `'url'`，或在没有 `window` / `localStorage` 时使用 `'localStorage'`，它什么也不做，也不会抛出错误。
- **`useReconnect()`** 返回 `client.reconnect()`：它立即从最后的序号重新开始每一条打开的事件流，所以应用在后台停留几分钟之后，既不会丢事件，也不会重复。在 `AppState` 变为 `active` 时调用它。
- **`useDeviceApproval(code)`** 驱动下面的审批界面。

## 4. 用手机批准一台电脑

`uncage setup` 会把审批链接打印成终端里的二维码（`--no-qr` 可关闭；输出不是终端时会跳过）。如果你用 Android App Links 或 iOS universal links 把 hub 的验证路径（默认 `/device`）映射到你的应用，扫码就会打开你的审批界面；否则手机会打开你的移动网页审批页。

```tsx nocheck
import { useDeviceApproval } from '@uncage/react';

export function ApproveScreen({ code }: { code: string }) {
  const { lookup, state, error, approve, deny } = useDeviceApproval(code);
  // state: 'loading' | 'idle' | 'approving' | 'denying' | 'approved' | 'denied'
  //        | 'not_found' | 'expired' | 'error'
  // lookup: { name?, os?, expiresAt, repairsMachine } | null: show it so the user compares the computer.
  // error: { code, message }, e.g. 'rate_limited' (10 wrong codes in 10 minutes).
  return null; // render lookup, error and two buttons that call approve() / deny()
}
```

当查询本身失败（例如 `rate_limited`）时，`state` 为 `'error'`；决定失败时会回到 `'idle'` 并设置 `error`，用户可以重试。`approve()` 和 `deny()` 只在 `'idle'` 时生效。它们底层调用 [`GET /device/lookup` 和 `POST /device/decision`](/docs/zh-cn/reference/http-api/)；`client.lookupDevice(code)` 和 `client.decideDevice(code, approve)` 是不依赖 React 的同一功能。

- **Android App Links：** 在你的网站上提供 `/.well-known/assetlinks.json`（包名和签名证书指纹）。`examples/connected-demo` 用 `ANDROID_PACKAGE` 和 `ANDROID_SHA256` 生成它。已构建并做过单元测试；等待真机确认。
- **iOS universal links：** 提供 `/.well-known/apple-app-site-association`（Team ID 和 bundle id；演示里是 `APPLE_TEAM_ID`、`IOS_BUNDLE_ID`）。需要付费的 Apple Developer 账号；已实现且可配置，**尚未在真机上验证**。在 iOS 上，二维码会回退到移动网页审批页。

## 不用付费账号

除 iOS 链接和 iOS 推送外，其余都可以用免费工具完成：用 Expo Go 体验聊天、电脑、审批、选择器和照片；用免费的 Expo 账号和 EAS 打出 Android 开发构建（推送、App Links）；用免费的 Firebase 项目提供 Android 推送。示例的 README 里有具体步骤。

## 接下来

[应用认证](/docs/zh-cn/guides/authenticate-apps/) · [推送通知](/docs/zh-cn/guides/push-notifications/) · [自定义 UI](/docs/zh-cn/guides/custom-ui/) · [HTTP API](/docs/zh-cn/reference/http-api/)
