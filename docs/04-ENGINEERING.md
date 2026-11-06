# Uncage — 研发实现规范（Engineering Design / API Contract）

> V0.1 · 2026-11-06 · 可直接转化为 Epic、任务、代码脚手架及接口测试

## 1. 仓库结构

```text
uncage/
├── apps/
│   ├── playground/             # 开发者体验 / 功能调试
│   └── docs/                   # 文档站（可后置）
├── examples/
│   ├── nextjs-default-chat/
│   └── react-headless-chat/
├── packages/
│   ├── protocol/               # Zod schemas + TS types
│   ├── core/                   # Node API + orchestration contracts
│   ├── server/                 # HTTP/SSE/daemon/SQLite
│   ├── runtime-claude/         # Claude Agent SDK adapter
│   ├── runtime-codex/          # Codex App Server adapter
│   ├── client/                 # browser TypeScript transport SDK
│   ├── react/                  # Headless provider/hooks
│   ├── react-ui/               # Default chat + approvals
│   ├── cli/                    # uncage doctor / serve
│   └── testkit/                # fake runtime + adapter contract tests
├── docs/rfcs/
└── pnpm-workspace.yaml
```

建议发布包（均为**暂定**，npm scope 是否可用需核验）：`@uncage/protocol`, `@uncage/core`, `@uncage/server`, `@uncage/runtime-claude`, `@uncage/runtime-codex`, `@uncage/client`, `@uncage/react`, `@uncage/react-ui`, `@uncage/cli`。

## 2. 公共 API 设计（初稿）

```ts
import { createUncage } from '@uncage/core';
import { claudeAdapter } from '@uncage/runtime-claude';
import { codexAdapter } from '@uncage/runtime-codex';

const uncage = createUncage({
  workspaceRoot: '/Users/me/projects/demo',
  adapters: [claudeAdapter(), codexAdapter()],
  permissions: { default: 'ask', allowSessionScope: false },
});

const runtime = await uncage.runtimes.get('codex');
console.log(runtime.capabilities);
const session = await uncage.sessions.create({ runtime: 'codex' });
const run = await session.startRun({ prompt: 'Inspect the project' });
for await (const event of session.events({ after: 0 })) {
  console.log(event.type, event.payload);
  if (event.type === 'run.completed' && event.runId === run.id) break;
}
```

示例是**拟定的 Uncage SDK 接口**，非已实现的包。不要把 `session.startRun()` 和 `session.events()` 混成内部同步执行调用；Server 必须允许 API 命令与事件连接独立。

## 3. REST 端点与响应约定

| Method | Path | 功能 | 返回 |
|---|---|---|---|
| GET | `/v1/health` | 服务状态/协议版本 | 200 |
| GET | `/v1/runtimes` | Runtime 探测/能力 | 200 |
| POST | `/v1/sessions` | 创建 Session | 201 |
| GET | `/v1/sessions/:id` | Session snapshot | 200/404 |
| GET | `/v1/sessions/:id/events?after=N` | SSE / replay | 200 text/event-stream |
| POST | `/v1/sessions/:id/runs` | 创建 Run；要求 Idempotency-Key | 202 |
| GET | `/v1/runs/:id` | Run 状态 | 200/404 |
| POST | `/v1/runs/:id/cancel` | 取消 Run | 202/409 |
| GET | `/v1/approvals?sessionId=...` | 待处理审批列表 | 200 |
| POST | `/v1/approvals/:id/decision` | allow/deny；要求 Idempotency-Key | 200/202/409/410 |

所有错误统一：

```json
{
  "error": {
    "code": "approval_already_resolved",
    "message": "This approval has already been resolved",
    "retryable": false,
    "details": {"approvalId": "apr_01"},
    "requestId": "req_01"
  }
}
```

错误码至少：`runtime_unavailable`, `auth_required`, `unsupported_capability`, `invalid_workspace`, `session_busy`, `approval_expired`, `approval_already_resolved`, `event_replay_unavailable`, `runtime_disconnected`, `policy_denied`, `internal_error`。

## 4. 协议 TS 类型

```ts
export type RunState =
  | 'queued' | 'running' | 'waiting_approval'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type ApprovalState =
  | 'pending' | 'submitting' | 'approved' | 'denied'
  | 'expired' | 'cancelled' | 'failed' | 'reconciling';

export interface Session {
  id: string;
  runtimeId: string;
  workspaceId: string;
  status: 'ready' | 'busy' | 'unavailable' | 'closed';
  createdAt: string;
  capabilities: RuntimeCapabilities;
}

export interface EventEnvelope<T = unknown> {
  eventId: string;
  sequence: number;
  sessionId: string;
  runId?: string;
  type: string;
  occurredAt: string;
  schemaVersion: '1.0';
  payload: T;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  runId: string;
  toolId?: string;
  runtimeId: string;
  category: 'shell' | 'file' | 'network' | 'mcp' | 'other';
  title: string;
  description?: string;
  target: { command?: string; cwd?: string; path?: string; host?: string };
  allowedScopes: Array<'once' | 'session'>;
  state: ApprovalState;
  expiresAt?: string;
  version: number;
}

export interface ApprovalDecision {
  decision: 'allow' | 'deny';
  scope: 'once' | 'session';
  reason?: string;
}
```

Runtime-specific 扩展存储在 `extensions: Record<string, unknown>`，key 采用命名空间格式，例如 `codex.xxx`，客户端必须能忽略未知字段。

## 5. 事件词表与 Reducer 规则

必需：`session.created`, `session.updated`, `run.started`, `run.updated`, `run.completed`, `run.failed`, `run.cancelled`, `message.started`, `message.delta`, `message.completed`, `tool.started`, `tool.updated`, `tool.completed`, `tool.failed`, `approval.requested`, `approval.updated`, `approval.resolved`, `system.warning`。

- `sequence` 每 Session 单调递增，不允许复用。
- `message.delta` 带 messageId + chunkIndex 或增量 offset，断线 replay 不得重复拼接。
- `tool.started` 和 `tool.completed` 使用同一个 toolId；同一工具可能重复 status 更新。
- `approval.resolved` 不自动发 `tool.completed`。
- SSE 的 `id:` 必须等于 eventId；`Last-Event-ID` 映射回 sequence。

## 6. React Store 与组件分层

```text
UncageClient (transport + auth + replay)
  -> SessionStore (normalized canonical state)
      -> useSession / useRun / useMessages / useApprovals
          -> Default UI (presentational components)
```

内部 store 可以用 `useSyncExternalStore` 的订阅模型，避免将 React 作为协议依赖。前端 state 的实体表：sessions、runs、messages、tools、approvals、connection。所有传入 event 必须经过 `applyEvent(state,event)` reducer；`ApprovalCard` 不直接调用 fetch，只调用 `useApprovalActions().decide()`。

```tsx
import { UncageProvider, AgentChat } from '@uncage/react-ui';

export function Page() {
  return (
    <UncageProvider endpoint="http://127.0.0.1:4783">
      <AgentChat approvals="inline" showTools showArtifacts />
    </UncageProvider>
  );
}
```

**生产部署注意：** 浏览器应用不应把本地高权限 token 写在公开前端代码中。上面展示的是开发体验草案，正式的认证握手应使用宿主同源 BFF 或受信任本地配对流程，绝不能靠硬编码 API key。

## 7. Runtime Adapter 实现要求

### Claude
1. 探测 SDK 及所依赖的可执行环境、版本与认证状态；缺失时输出可解释错误。
2. 用 SDK streaming 事件映射 `message.*`、`tool.*`、`run.*`。
3. `canUseTool` 请求 → `ApprovalRegistry.register()` → 等待受控决策 Promise → 返回官方允许/拒绝结果。
4. 核验 permission mode、hooks、allow/deny rules 是否提前解析了工具行为，不承诺回调能看到所有调用。
5. 会话恢复仅在官方当前 SDK 能力及版本验证后开启 capability；可只恢复展示历史。

### Codex
1. 使用 `child_process.spawn` 启动 `codex app-server` 的 stdio 模式；**切勿将 prompt 拼接 Shell 字符串**。
2. 按 JSONL 消息边界解析，建立 JSON-RPC request id / response map，支持服务端请求。
3. `thread/start`、`turn/start`、`item/*`、`turn/completed` 映射公共事件。
4. `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` 等映射审批类别；不同请求使用不同合法 decision payload。
5. `cancel` / interrupt 映射原生取消方法；关闭进程时确保工作目录、stdout/stderr、pending map 清理。
6. WebSocket 模式不作为 V0 必须依赖；其生产适配需单独安全审查。

## 8. Approval Registry 伪代码（生产实现须事务化）

```ts
async function decide(approvalId: string, decision: ApprovalDecision, actor: Actor) {
  const approval = await db.approvals.get(approvalId);
  assertAuthorized(actor, approval.sessionId);
  assertPolicyAllows(actor, approval, decision);
  const claimed = await db.approvals.compareAndSet(
    approvalId, { state: 'pending', version: approval.version },
    { state: 'submitting', decision }
  );
  if (!claimed) throw new ConflictError('approval_already_resolved');

  const handle = pendingNativeRequests.get(approvalId);
  if (!handle) return markInterruptedAndReconcile(approvalId);

  try {
    await handle.respond(decision);
    await db.approvals.setResolved(approvalId, decision.decision);
    await emit('approval.resolved', { approvalId, decision });
  } catch (err) {
    await markReconciliationRequired(approvalId, err);
  }
}
```

**关键补充：**一旦返回原生 Runtime 前未能确认结果，不能向 UI 声称成功；本地外部副作用可能已经发生，网络超时不能简单重试。

## 9. 配置约定

```yaml
server:
  host: 127.0.0.1
  port: 4783
  eventRetentionDays: 7
security:
  allowedOrigins:
    - http://127.0.0.1:3000
  requireLocalToken: true
  defaultApproval: ask
  allowSessionGrant: false
workspace:
  allowedRoots:
    - /Users/me/projects
runtimes:
  claude:
    enabled: true
  codex:
    enabled: true
```

这是示意配置；实际 loader 应通过 Zod 校验，拒绝未知危险配置，允许通过环境变量覆盖无敏感字段。禁止配置导出真实 access token。

## 10. 测试用例矩阵（QA）

| ID | 场景 | 断言 |
|---|---|---|
| T01 | Claude 创建 session/run | 正确收到 terminal run event |
| T02 | Codex 创建 session/run | 正确关联 threadId/turnId |
| T03 | 消息 delta 重放 | 不重复拼接，顺序稳定 |
| T04 | 审批 Allow once | Runtime 接收原始允许结果 |
| T05 | 审批 Deny | Runtime 接收拒绝；UI 不误标 run failed |
| T06 | 双客户端同时审批 | 只有一个被接受，另一个 409 / 已解决 |
| T07 | 审批超时 | UI expired、底层安全拒绝或 interrupt |
| T08 | 取消 Run | 子进程/原生执行停止，最终状态清晰 |
| T09 | 刷新/断线后补事件 | 历史不重复、未决审批可恢复 |
| T10 | Runtime 异常退出 | Run interrupted、pending approvals 终止 |
| T11 | 非法 Origin / Token | HTTP 403/401，命令不执行 |
| T12 | 未授权路径 | 禁止创建 Workspace / 不越权 |
| T13 | Runtime 不支持 feature | 返回 unsupported_capability |
| T14 | Headless UI | 不引入 react-ui 也能运行完整流程 |
| T15 | 日志安全 | 不泄漏 token、私密环境变量、prompt 内容 |

## 11. CI/CD 和发布

- PR 必须通过 TS typecheck、lint、unit、contract、mock E2E。
- Nightly/受控 CI 做真实 Claude & Codex E2E；专用测试账号，限制预算，避免用个人凭据。
- 每次版本固定 `node`, `sdk`, `codex cli` 最低/验证版本，发布兼容矩阵。
- 包发布使用 Changesets + SemVer；协议变更提供 migration notes。
- Release artifacts 有 SHA/校验信息、SCA 依赖扫描、secret scanning。
- 安全问题使用 private disclosure 流程，不在 issue 公开复现密钥。

## 12. 首个 Demo 的 Done 定义

`pnpm install -> pnpm build -> uncage doctor -> uncage serve -> pnpm dev`，在受支持的环境完成：
- 使用 Claude Code 和 Codex 分别运行“扫描仓库结构 + 运行测试”任务。
- UI 显示事件和工具卡片，必要时发出审批，并能 Allow/Deny。
- F5 刷新后恢复已持久化事件，若 native run 丢失则明示 interrupted。
- 换成 `react-headless-chat` 后相同后端无需改变。
- 无外部 API key 明文、默认无公网监听、错误可诊断。
