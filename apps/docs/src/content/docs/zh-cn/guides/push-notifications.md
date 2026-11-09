---
title: "推送通知"
description: "在用户的电脑需要他们时通知用户：hub 的 onAttention 钩子（请求审批、运行完成或失败）、最多一次的投递与过期事件抑制、现成的 expoPushNotifier、登记设备令牌以及如何测试。"
---

当有审批在等待，或一次运行结束时，把应用装在口袋里的用户应该知道。hub 会为此调用你的 `onAttention` 钩子；推送由你自己的服务商发送。对于 Expo Push，我们提供了现成的处理函数。

## `onAttention`

```ts title="attention.ts"
import type { AttentionEvent, OnAttention } from '@uncage/hub';

export const onAttention: OnAttention = async (e: AttentionEvent, { waitUntil }) => {
  // e.kind: 'approval_requested' | 'run_completed' | 'run_failed'
  // e.userId, e.sessionId, e.sessionTitle?, e.machineId, e.machineName?, e.runtime?,
  // e.approval?: { id, title, category }, e.at (when it happened on the computer)
  waitUntil(sendPush(e.userId, `${e.kind}: ${e.sessionTitle ?? e.sessionId}`));
};

declare function sendPush(userId: string, text: string): Promise<void>;
```

把它作为 `createHub({ …, onAttention })` 传入。它的行为是：

- **每个事件一次。** 它在 hub 接受事件之后触发，两种 `sessionStorage` 模式都会触发，按 `sessionId:sequence:kind` 每个只触发一次：守护进程重发，或多个 hub 节点都看到同一事件，都只会通知一次。去重使用存储的可选方法 `claimOnce(key, { ttlSec, now })`（SQL、Postgres 和 PGlite 存储都已实现，记录保留一天）。没有 `claimOnce` 的自定义存储会退回到每个节点的内存去重，尽力而为。
- **投递最多一次。** 如果你的处理函数抛出错误或 reject，错误会写入 `logger.error`，事件**不会**重试。
- **从不阻塞写入。** 错误不会让事件失败。在 FaaS 平台上，调用运行在请求的 `waitUntil` 之下；`ctx.waitUntil` 可以把更多工作交给同一个上下文。
- **过期事件会被跳过。** 事件时间早于 **10 分钟**的（守护进程重连后补发的旧事件）永远不会通知。在 `'site'` 模式下，存储的快照已显示为已回答的审批也会被跳过。
- **时钟说明。** “早于”是用电脑时钟给出的事件时间和 hub 的时钟比较的。请让两者相差不超过几分钟（NTP）。时钟慢了超过 10 分钟的电脑永远不会触发通知；hub 会记录一条警告，每台电脑每小时最多一次。

## 离开你的 hub 的内容

推送会从你的 hub 发到 Expo，再到 Apple 或 Google，并显示在锁屏上。默认文案由事件和**审批标题**生成，而运行时会根据工具调用来设置这个标题，所以它可能包含命令或文件路径。默认文案是一行，最多 180 个字符（包含审批标题和会话标题），但仍会到达这些服务和锁屏。如果这对你的用户来说太多，可以从 `message` 返回一段通用文案：

```ts
import { expoPushNotifier } from '@uncage/hub';

declare const tokensFor: (userId: string) => Promise<string[]>;

expoPushNotifier({
  tokensFor,
  message: (e) => ({ title: 'Uncage', body: e.approval ? 'An action needs your approval' : 'Your run has finished' }),
});
```

## `expoPushNotifier`

```ts title="hub.ts"
import { expoPushNotifier } from '@uncage/hub';

declare const tokenDb: {
  list(userId: string): Promise<string[]>;
  remove(token: string): Promise<void>;
};

export const onAttention = expoPushNotifier({
  // The user's Expo push tokens, from YOUR database: the hub never stores them.
  tokensFor: (userId) => tokenDb.list(userId),
  // Expo reported DeviceNotRegistered (app uninstalled): delete the token.
  onInvalidToken: (token) => tokenDb.remove(token),
});
```

它只使用 `fetch`，所以 hub 能运行的地方它都能运行（它从符合 Web 标准的根入口导出）。它为每个令牌发送一条消息，每个请求最多 100 条，并带有 `data: { sessionId, approvalId?, kind }`，应用可以据此打开对应的聊天。

| 选项 | |
| --- | --- |
| `tokensFor(userId)` | 必填。用户的 Expo 推送令牌。 |
| `accessToken` | 开启 enhanced push security 时使用的 Expo 访问令牌。 |
| `message(e)` | 每个事件的 `{ title, body }`，返回 `null` 则不发送。默认是简短的英文文案（`defaultPushMessage`）；在这里做本地化。 |
| `onInvalidToken(token)` | 对 Expo 报告为 `DeviceNotRegistered` 的令牌调用。 |
| `fetch`、`endpoint` | 替换 `fetch` 或 Expo 端点（用于测试）。 |
| `timeoutMs` | 对 Expo 的请求超过这个时间没有应答就会中止，调用随之 reject（hub 会记录）。默认 `15000`。 |

当请求失败或超时、`onInvalidToken` 抛出错误，或 Expo 因其他原因（例如 `InvalidCredentials`）拒绝了消息时，它会 reject；多次发送失败时，会以包含全部失败的 `AggregateError` reject（hub 会记录错误码和数量，但绝不记录令牌）。

## 登记令牌

应用请求权限，用 `expo-notifications` 取得令牌（`getExpoPushTokenAsync({ projectId })`），再把它发给**你的**后端，由后端按用户保存。`examples/connected-demo` 提供 `POST /api/app/push-token` `{ token }`（退出登录时用 `DELETE`），会校验令牌格式，每个用户最多保留 10 个（最旧的被丢弃）。30 天没有重新登记的令牌也会被丢弃。一个令牌同一时间只属于一个用户：设备上最新的登录者胜出，所以共用设备不会把通知泄露给上一个用户。请把令牌当作半保密信息。在演示里，设置 `EXPO_PUSH=1`（以及可选的 `EXPO_ACCESS_TOKEN`）即可打开 hub 的 `onAttention`。

## 各平台的情况

- 远程推送需要**开发构建**：自 SDK 53 起，Expo Go 在 Android 上没有推送。
- **Android：** 免费的 Expo 账号加 EAS 可以打出 Android 开发构建；免费的 Firebase 项目提供 FCM 凭据。已构建，并对着模拟的 Expo 端点做过单元测试；**等待真机确认**。
- **iOS：** 需要付费的 Apple Developer 账号（APNs）。已实现且可配置；**尚未在真机上验证**。

## 测试

用假的 `fetch`（这个选项就是为此而设）和一个会发出 `approval.requested` 的 hub 来为处理函数写单元测试：应当只调用一次，同一序号再次到来时不再调用，早于十分钟的事件也不调用。hub 自己的测试就是这样做的。

另见[挂载 hub](/docs/zh-cn/guides/mount-the-hub/)和 [React Native 应用](/docs/zh-cn/guides/react-native/)。
