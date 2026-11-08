---
title: 网站侧存储
description: 用 sessionStorage 'site' 在你的网站上保存每段对话的副本，让用户电脑关机时历史仍可查看，并在你自己的代码里读取副本和工具调用审计。
---

会话运行在用户电脑上，以那台电脑的本地数据库为准。问题在于：**你的网站**是否也保存一份副本。

| `sessionStorage` | 电脑离线时的历史 | hub 从哪里读取历史 |
| --- | --- | --- |
| `'machine'`（默认） | 看不到：会话列表为空，打开会话会以 `machine_offline` 失败 | 每次都询问电脑 |
| `'site'` | 完全可见，只读 | 它自己的存储（副本） |

如果过程应该一直在你的网站上可见（回看 agent 做了什么、分享结果、客户支持），就选 `'site'`。参考演示项目用的就是它。如果对话除了被查看的时候之外不能离开用户电脑，就选 `'machine'`。

```ts title="hub.ts"
import { createHub, type HubUser } from '@uncage/hub';
import { pgliteHubStore } from '@uncage/hub/node';

declare function getUser(req: Request): Promise<HubUser | null>;

export const store = await pgliteHubStore({ dataDir: './.uncage-hub' });
export const hub = await createHub({
  publicUrl: 'https://app.example.com',
  getUser,
  store,
  sessionStorage: 'site',
});
```

## 副本如何工作

- hub 只复制它自己创建的会话（`POST <basePath>/sessions` 会选定会话 id，并在电脑创建会话之前记录下来）。电脑为其他会话 id 发来的事件会被忽略并写入日志（`events for a session the hub did not create ignored`）。使用 `'machine'` 存储时，这类会话仍会被索引，以便列出。

- 会话的每个事件都有一个序号（1、2、3……）。电脑先把它写入自己的数据库，再发给 hub。
- hub 只追加它缺少的**下一个**序号，所以副本始终是会话的一个无空洞前缀，并向电脑确认已接收到的位置。
- 电脑重连时，hub 告诉它每个会话已有的最后一个序号，电脑从那里继续补传。离线期间不会丢失任何东西，也不会重复存储。
- 只有电脑写入事件，所以不存在冲突。审批仍由电脑判定：hub 转发决定，结果以事件的形式返回。
- 单个特别大的事件（例如巨量的命令输出）会被守护进程截短，并加上 `[truncated N bytes]` 标记，以便放进一个帧。副本依然没有空洞。
- hub 还为每个会话保存一份**快照**（会话、运行、待审批项、最后一个序号），由事件重建，这样打开会话时不必重放全部历史。

电脑离线时，`<AgentChat>` 会显示历史并禁用输入框：“你的电脑离线了，等待重新连接…”。电脑重连后，缺失的事件会补齐，会话恢复实时状态。

## 自己读取副本

保留你传给 `createHub` 的存储的引用，就可以在你自己的页面、管理工具或导出功能里读取它。务必按已登录用户过滤。

```ts title="history.ts"
import type { HubStore, ToolCallRecord } from '@uncage/hub';
import type { UncageEvent } from '@uncage/protocol';

/** A user's conversations, newest first, with their titles. */
export async function listConversations(store: HubStore, userId: string) {
  const sessions = await store.listSessions(userId); // oldest first
  return sessions.reverse().map((s) => ({ id: s.id, title: s.title, machineId: s.machineId, createdAt: s.createdAt }));
}

/** Every replicated event of one of the user's sessions, in order. */
export async function readConversation(store: HubStore, userId: string, sessionId: string): Promise<UncageEvent[]> {
  const session = await store.getSession(sessionId);
  if (!session || session.userId !== userId) throw new Error('not found');
  const events: UncageEvent[] = [];
  for (let after = 0; ; ) {
    const page = await store.readEvents(sessionId, after, 500);
    if (page.length === 0) return events;
    events.push(...page);
    after = page[page.length - 1]!.sequence;
  }
}

/** What your tools did in a session: one row per call, with status and timing. */
export function toolCalls(store: HubStore, sessionId: string): Promise<ToolCallRecord[]> {
  return store.listToolCalls(sessionId);
}
```

`sessionStorage` 为 `'site'` 时，`SessionRecord.snapshot` 保存最新的快照。[自动生成的参考](/docs/api/hub/)列出了 `HubStore` 的所有方法。在你的代码里把存储当作只读；它的表归 hub 管理。

## 工具调用审计（两种模式都有）

无论 `sessionStorage` 是什么，hub 都会记录每次网站工具调用：谁（`userId`、`machineId`）、哪个会话和运行、哪个工具、参数（超过 16 KB 的除外）、状态（`running`、`ok`、`error`、`invalid`、`timeout`、`cancelled`）、错误码和消息，以及耗时。用 `store.listToolCalls(sessionId)` 读取。

## 保留期限与空间

hub 不会删除复制来的事件。请为空间做好规划：一次典型的运行有几十到几百个事件，大多是很小的文本增量。如果需要保留期限，请按你自己的节奏在数据库里删除旧会话的行（表由 `migrateHubStore` 创建；schema 见 `@uncage/hub` 里的 `HUB_MIGRATIONS`）。

## 附件

浏览器里上传的附件会发送到电脑，电脑在会话工作区里保留自己的一份。**两种模式下（包括 `'machine'`），hub 也会在它的存储里保留一份副本**（`uncage_hub_attachments`），这样图片或文件仍能显示在对话历史里。这份副本会在以下时候删除：

- 超过 `attachmentRetentionDays` 之后（默认 30 天，每个节点每小时检查一次）；此后 `GET <basePath>/attachments/:id` 返回 404；
- 电脑被吊销时立即删除（从网站、`hub.revokeMachine`，或在电脑上运行 `uncage sites remove`）。

传入 `attachmentRetentionDays: Infinity` 可以一直保留到电脑被吊销；如果附件不能留在你的服务器上，就传一个更小的数字。

## 切换模式

`sessionStorage` 可以随时修改。切换到 `'site'` 后，电脑下次连接时，它的每个会话都会从第一个事件开始复制。切换回 `'machine'` 后，已有的副本行会留在存储里，不再使用。
