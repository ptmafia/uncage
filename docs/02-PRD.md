# Uncage — 产品需求文档（PRD）

> 版本 V0.1 · 2026-11-06 · 目标：研发可拆任务、设计可画稿、QA 可验收

## 0. 决策摘要

**定位：** Local-first Runtime Integration Kit，而非新的 Agent Framework。

**V0 范围：** macOS + Node.js/TypeScript + React；Claude Agent SDK Adapter 与 Codex App Server（stdio）Adapter；本地受控 Server；统一 Sessions / Runs / Events / Approvals；默认 Chat + Headless hooks；演示工程。Linux 可作为兼容目标但不阻断 V0，Windows 后置并公开限制。

**非目标：** 自研 Harness、浏览器直接运行 CLI、多租户 SaaS、通用任务编排、云端持久执行、跨 Runtime 无损会话迁移、移动端原生 UI、计费平台。

## 1. 角色与场景

- **Host Developer：**集成 SDK、配置 Runtime 与 UI、设置安全策略。
- **End User：**向 Agent 下达任务、查看过程、审批工具调用。
- **Runtime Operator：**管理本地进程、工作目录、日志及故障排查。

| ID | 用户故事 | 优先级 |
|---|---|---|
| US-01 | 开发者调用统一接口列出可用 Runtime/capabilities | P0 |
| US-02 | 开发者创建 session、发送 prompt 并获取 runId | P0 |
| US-03 | 用户看到实时消息和工具执行状态 | P0 |
| US-04 | 用户允许/拒绝权限请求，结果正确回到 Runtime | P0 |
| US-05 | 用户取消当前运行并看到最终状态 | P0 |
| US-06 | 浏览器重连后恢复历史事件和未决审批 | P0 |
| US-07 | 使用默认 React Chat，无需自己实现界面 | P0 |
| US-08 | 用 Headless SDK 完全自定义渲染 | P0 |
| US-09 | 查看文件变更摘要/差异（如 Runtime 支持） | P1 |
| US-10 | 多会话管理、搜索、任务控制台 | P1 |
| US-11 | 受控远程 Host、多用户管理 | P2 |

## 2. 使用路径与信息架构

### 首次接入

1. 运行 `uncage doctor`：检查 Node、Runtime 安装、认证状态、操作系统与配置。
2. 选择 Claude Code 或 Codex，明确 workspace 目录及可用权限策略。
3. 启动 LocalAgent Server（仅监听 loopback，默认不对公网开放）。
4. 打开 Example UI，选择 Runtime，创建 Session，提交任务。
5. 收到权限请求 → 审核命令、工作区、风险 → 允许一次或拒绝。

### 默认 Chat UI 组件树

```text
<UncageProvider>
  <AgentWorkspace>
    <SessionSidebar />
    <AgentHeader>RuntimeSelector / ConnectionStatus</AgentHeader>
    <ConversationViewport>
      <MessageList>
        <UserMessage />
        <AssistantMessage />
        <ToolActivity />
        <ApprovalCard />
        <ArtifactPreview />
      </MessageList>
    </ConversationViewport>
    <Composer />
    <RunStatusBar />
    <ApprovalDrawer />           // 可选
  </AgentWorkspace>
</UncageProvider>
```

默认第一屏是 Conversation；工具/审批在消息流 inline 出现，右侧 Drawer 为可选增强，不强制常驻。

## 3. 交互说明与验收

### R-01 Runtime 选择

- 显示已发现、可用、未安装、未认证、不兼容等状态。
- 选择 Runtime 只影响**新建 Session**；已有 Session 不能隐式迁移到另一个 Runtime。
- 读取 capabilities 决定 UI 是否显示续接、文件 Diff、会话级授权等选项。

**验收：**本机未安装 Codex 时，明确提示原因并给出官方安装入口；不能用空白异常代替。

### R-02 会话与运行

- `Session`：持续对话容器，绑定 runtime、workspace、runtimeSessionRef（可选）。
- `Run`：一次用户请求与相关执行，包含 queued / running / waiting_approval / completed / failed / cancelled / interrupted。
- 当前 Session 同时最多一个 active Run（V0）；跨 Session 可并发，但设全局进程/资源上限。
- Run 结束应显示明确状态，不能把“已允许”误显示为“命令成功”。

**验收：**重复点击发送不会产生重复 run；运行中按钮切换为 Cancel。

### R-03 实时事件

- 消息 delta 拼接；工具 call started/completed/failed；审批 requested/resolved；session/run 状态；错误。
- Event 要具备 `eventId`（递增序列）、sessionId、runId、时间、类型、payload。
- 前端以事件快照重建 UI，处理重复和乱序；重连优先从 lastEventId 补齐。
- 传输选 SSE（服务端事件推送）+ HTTP command；不在 V0 引入双向 WebSocket 必需依赖。

**验收：**断网重连、页面刷新不重复工具记录、不丢失未决审批；如无法恢复，明确告知。

### R-04 权限审批

- 请求包含完整命令/目标、工作目录、解释、有效期、Runtime 身份、风险提示和可用授权 scope。
- V0 默认操作：**Allow once / Deny**；会话授权仅在 Runtime 和服务端都支持且策略允许时显示。
- 点击后进入 `submitting`；服务端确认后进入 `approved` / `denied`；超时/取消/失败独立显示。
- 拒绝并不必然结束整个 Run，具体由 Runtime 决定。
- 所有审批必须由服务端校验，UI 不持有提权 token。

**验收：**双标签页同时提交仅有一个有效决策；另一个收到已处理状态；事件能够正确关联原始工具调用。

### R-05 默认 UI / Headless UI

- Default UI 至少包括 MessageList、Composer、ToolActivity、ApprovalCard、RunStatus、RuntimeSelector。
- UI 通过 Provider + hooks 获取状态，所有状态在 SDK store 中归一化，组件不可各自独立订阅 Runtime。
- Headless hooks：`useSession`、`useRun`、`useMessages`、`useApprovals`、`useApprovalActions`、`useRuntimeCapabilities`。
- 组件可主题化、可替换、键盘可用；开发者可隐藏默认 UI、独立使用 hooks。

**验收：**一个完整自定义 UI 示例能复用相同 Client，覆盖发送、stream、审批、取消。

### R-06 错误与空状态

| 类型 | UI 行为 | 继续方式 |
|---|---|---|
| Runtime 未安装 | 显示 `runtime_unavailable` 与诊断信息 | 安装并重新探测 |
| 凭据不可用 | 显示 `auth_required`，不暴露凭据 | 在受支持流程中登录 |
| 运行断连 | 显示 `interrupted`，停止假装 streaming | 重连/重新运行（明确区别） |
| 审批已失效 | 禁用按钮并显示 `expired` | 由 Runtime 重新发起 |
| 事件缺口 | 加载 snapshot + replay，失败则标记不完整 | 手动刷新状态 |
| 工具执行失败 | 显示工具失败并继续读取 run 结果 | 不假设整个 Run 失败 |

## 4. V0 功能优先级

### Must Have
- Runtime discovery + capabilities + health
- Claude / Codex adapter golden path（含单次审批）
- Local Server + SDK + run/session + event persistence
- 默认 Chat、Headless React SDK
- Approval Registry（幂等、过期、事件同步）
- CLI doctor、README、Next.js 示例
- 不安全默认值检查、结构化日志、基本测试

### Should Have
- Diff 展示、会话历史浏览、手动重新连接、导出调试包（敏感信息脱敏）

### Won't Have in V0
- Remote 云托管、多租户控制台、任务排队系统、SDK 热升级、共享登录、Runtime 间上下文迁移

## 5. 非功能性要求

- **安全：**仅 loopback 监听；访问需要本地生成的授权 token + Origin 校验；workspace 不可超范围；拒绝优先；默认不可自动批准高风险命令。
- **性能目标（初始 SLO，需实测调整）：**在正常本机环境下 Uncage 自身事件分发 p95 < 200ms（不计 Runtime/模型延时）；发送指令到可观察的 run.started p95 < 500ms（Runtime 启动另计）。
- **可靠性：**事件至少一次投递、客户端按 eventId 去重；审批通过原子 CAS 防重复。
- **存储：**单机 SQLite 或等效本地持久存储保存元数据及有限事件；凭据不存储于事件库。
- **隐私：**telemetry 默认关闭；日志屏蔽凭据、敏感环境变量，不默认上传 prompt 或文件内容。
- **可维护性：**Adapter contract tests + Runtime version matrix；协议按 SemVer 演进。

## 6. 成功与退出门槛

- 两种 Runtime 在声明支持的版本上跑通 golden path。
- 自动化 E2E 覆盖流式消息、允许、拒绝、取消、重连、Runtime 异常。
- 新开发者在干净 macOS 环境依照文档完成首个 run。
- Headless UI 示例不依赖默认组件源码。
- 安全 review 没有未闭环的 P0/P1 问题。

## 7. 设计交付清单

- 运行态 Chat（idle/streaming/tool/approval/completed/failed）
- runtimeSelector 的 5 种可用性状态
- ApprovalCard 全状态与展开详情
- 操作中 / 已过期 / 双端重复审批冲突 UI
- 断线恢复 banner、可访问性与暗色模式
- 移动宽度布局（虽非移动端正式支持，也不应明显溢出）

## 8. Open Questions（必须在开发 kickoff 决策）

1. V0 仅 macOS，还是 Linux 作为非阻断 best-effort？（建议 macOS 正式支持）
2. Codex 是否只用 App Server stdio？（建议是）
3. UI 状态缓存选 TanStack Query + reducer，还是 SDK 自带 Zustand store？（建议独立 reducer/store，对 React 无侵入）
4. 数据保留时长与最大事件容量？（建议可配置，默认 7 天/单机容量上限）
5. 开源许可证与品牌可用性？（发布前法务/产品确认）
