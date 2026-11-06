# Uncage V0 — 首轮实现设计（Design）

> 2026-11-06 · 基于 `docs/01-GTM.md`、`docs/02-PRD.md`、`docs/03-ARCHITECTURE.md`、`docs/04-ENGINEERING.md`
> 本文只记录**本轮实现的范围与已定决策**；产品/架构/接口细节以上述四份文档为准，冲突时以本文为准。

## 1. 意图

Uncage 是本地优先的开源 Agent Runtime 集成套件：把 Claude Code / Codex 等现成 Runtime，通过统一的 Sessions / Runs / Events / Approvals 接口、HTTP + SSE 传输和 React SDK 嵌入已有应用，不自研 Agent Loop。

本轮目标：**用真实的 Claude Code 端到端跑完整链路**，产出可运行的 monorepo，作为 Private Alpha 的基础。

## 2. 验收（Done 定义）

在本机 macOS（Node 24 / pnpm 10，`claude` CLI 已登录）上：

`pnpm install → pnpm build → uncage doctor → uncage serve → pnpm dev`，在浏览器中**用真实 Claude Code** 完成：

1. 看到 Runtime 列表与可用性状态（Claude 可用；Codex 显示未安装 `runtime_unavailable` 及安装指引）。
2. 新建 Session，发送真实任务（如“扫描仓库结构并运行测试”），获得 runId。
3. 实时看到流式消息、工具执行卡片（started/completed/failed）。
4. 真实触发权限审批，Allow once / Deny 均正确回传 Runtime；Deny 不把 Run 误标为 failed。
5. 运行中 Cancel，Run 进入 cancelled，子进程被清理。
6. F5 刷新：历史事件不重复、未决审批可恢复；原生执行已丢失时明确显示 interrupted。
7. 双标签页同时审批：仅一个生效，另一个收到已处理状态（409）。
8. 切换到 `examples/react-headless-chat`，后端不改，同样跑通发送 / 流式 / 审批 / 取消。
9. 默认仅监听 127.0.0.1；无 token 或非法 Origin 返回 401/403。

上述每项需有实际运行证据（Playwright live E2E 或手工运行记录）。

## 2.5 易用性要求（开发者体验，用户明确强调）

面向开发者也必须“足够易用”。以下作为与功能同级的验收项：

1. **最短接入**：默认 UI 接入 ≤ 10 行代码——服务端一行 `createUncageHandler()`（Next.js route handler 挂载即用，内部负责 token 代理），前端 `<UncageProvider><AgentChat /></UncageProvider>`。
2. **零配置启动**：`uncage serve` 无配置文件也能运行（默认 127.0.0.1、默认端口、当前目录作为 workspace、自动发现已安装 Runtime）；配置文件只用于覆盖默认值。
3. **一条命令自检**：`uncage doctor` 逐项列出 ✓/✗，每个 ✗ 附带可复制的修复命令（如 Codex 未安装 → 安装命令与登录命令）。
4. **错误可行动**：所有错误码带人话 message + 修复建议（`hint` 字段）；SDK 抛出带类型的错误，可 `switch (err.code)`。
5. **类型即文档**：公共 API 完全 TypeScript 类型化，事件为可辨识联合（`event.type` 收窄 payload）；hooks 返回值不需要查文档就能用。
6. **渐进式定制**：默认组件 → 传 props 改行为 → 替换单个子组件（slot）→ 完全 headless hooks，每一层都不要求改服务端。
7. **README Quickstart** 在干净环境中 5 分钟内跑通首个 run，作为本轮验收的一部分（由实现者按 README 实际走一遍验证）。

## 3. 范围

### 做
`docs/04-ENGINEERING.md` §1 中的全部包：`protocol`、`core`、`server`、`runtime-claude`、`runtime-codex`、`client`、`react`、`react-ui`、`cli`、`testkit`；示例 `examples/nextjs-default-chat`、`examples/react-headless-chat`；`apps/playground` 可与 nextjs 示例合并（实现者决定）。

### Codex
- `runtime-codex` 按 Engineering §7 完整实现（stdio JSON-RPC、审批映射、取消、清理）。
- **本机未安装 Codex，本轮不做真机验证**：用 testkit 中的 fake `codex app-server`（脚本化 JSONL 进程）做 contract test 与 mock E2E。
- `probe()` 在未安装时必须返回清晰的 `runtime_unavailable`。
- 由于协议细节只能依据官方文档/源码推断，代码中标注“未经真机验证”，兼容矩阵中标记为 experimental。

### 不做
文档站（`apps/docs`）、多租户 / 远程 Host、telemetry、Linux/Windows 适配、会话级授权 scope（V0 默认关闭，仅保留类型）、Runtime 间上下文迁移、npm 发布。

## 4. 已定决策

| 项 | 决策 | 来源 |
|---|---|---|
| 存储 | **PGlite**（WASM Postgres）+ Drizzle ORM，替代文档中的 SQLite；存储层隔一层 repository 接口以便回退 | 用户决定 |
| 真实 Runtime | 仅 Claude Code 真机；Codex mock | 用户决定 |
| 平台 | macOS 正式支持 | PRD Open Q1 建议 |
| Codex 传输 | 仅 App Server stdio | PRD Open Q2 建议 |
| 前端状态 | 独立 reducer/store（`applyEvent`）+ `useSyncExternalStore`，不依赖 Zustand/TanStack | PRD Open Q3 建议 |
| 事件保留 | 可配置，默认 7 天 | PRD Open Q4 建议 |
| 技术栈 | pnpm workspaces + Turborepo、Fastify、Zod、Vitest、Playwright、Pino、tsup | Architecture §12 |

## 5. 实现者自行决定（我方判断，可调整）

- Claude 接入使用 `@anthropic-ai/claude-agent-sdk` 当前稳定版的 `query()` streaming + `canUseTool`；复用本机 `claude` 登录状态，不在 Uncage 中存储凭据。具体版本在实现时核验并写入兼容矩阵。
- 真实运行时 permission mode 使用 `default`，保证会触发审批；不暴露 `bypassPermissions`。
- 本地 token：`uncage serve` 启动时生成并写入 `~/.uncage/token`（0600）；示例应用通过 Next.js 服务端路由（同源 BFF）读取并代理，不把 token 暴露到浏览器 bundle。
- PGlite 数据目录默认 `~/.uncage/data`；`uncage doctor --export-events <sessionId>` 导出脱敏事件 JSON，弥补无法直接查库的不便。
- **多轮上下文**：同一 Session 内后续 Run 延续前文。Claude 适配器保存 SDK 返回的原生 session_id 到 `runtime_refs`，下一个 Run 通过 SDK `resume` 续接；原生会话丢失时 Session 降级为“只读历史”，UI 提示新建会话。fake Codex 同样维护 thread 状态。
- **认证路径**：浏览器 → 宿主同源 BFF（`createUncageHandler()`，Next.js route handler）→ `uncage serve`。BFF 在服务端附加 token，代理 HTTP 命令和 SSE（流式透传）。`uncage serve` 对所有请求强制校验 token；若请求带 `Origin` 头（浏览器直连）则必须在 allowlist 内，默认 allowlist 为空 → 浏览器直连一律 403。验收项 9 即测：无 token 401、恶意 Origin 403。两个示例都是 Next.js 应用并复用 `createUncageHandler()`。
- **`@uncage/core` 可独立嵌入**：core 是公共 Node SDK（Engineering §2 的 `createUncage()`），`server` 只是在其上包一层 HTTP/SSE。core 的 `dataDir` 可配置；同一数据目录同时只能由一个进程打开，冲突时给出明确错误与提示。
- **Workspace**：`POST /v1/sessions` 可选传 `workspace` 路径，必须经 realpath 后位于 `allowedRoots` 内（零配置时 `allowedRoots = [启动目录]`，默认 workspace 即启动目录）；越界返回 `invalid_workspace`。默认 UI 不做目录选择器。
- **断线与审批时效**：浏览器断开不影响 Run，继续执行并持久化事件；未决审批默认 TTL 10 分钟（可配置），过期后向 Runtime 返回拒绝并发 `approval.updated(expired)`。刷新在 TTL 内都能恢复审批。服务重启时，运行中的 Run 标 interrupted，未决审批标 expired。
- ESM-only 包输出。
- UI 视觉：简洁、可主题化（CSS 变量）、支持暗色；不追求设计稿级精细度。

## 6. 测试分层

- **每次提交**：typecheck、lint、unit、adapter contract（fake runtime）、mock E2E（Playwright + fake runtime）。
- **本轮手工/受控**：Claude live E2E，覆盖 §2 中 1–9 项，需要本机登录和真实额度，不进入默认 CI。
- QA 矩阵以 `docs/04-ENGINEERING.md` §10 T01–T15 为准，T02（Codex 真机）本轮以 mock 替代。

## 7. 风险

- Claude Agent SDK 的 `canUseTool` 不一定拦截所有工具调用（受 permission mode / rules / hooks 影响），live 测试需选一个确定会触发审批的任务（如执行 shell 命令写文件）。
- PGlite 单进程打开数据目录：`uncage serve` 运行时 `doctor --export-events` 需走 HTTP 接口而非直接开库。
- Live E2E 依赖模型输出，断言应针对事件类型和状态，不针对文本内容。
