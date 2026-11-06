# Uncage — GTM 与开源增长策略

> 版本 V0.1 · 2026-11-06 · Owner：产品/Growth · 状态：立项草案

## 1. 一句话定位

**Uncage — Bring your agent to any app.**

Use the harness you trust. Ship the experience you own.

Uncage 是面向应用开发者的开源 Agent Runtime Integration Kit：把 Claude Code、Codex 等成熟 Agent Runtime，通过统一 API、生命周期管理和可组合 UI SDK 嵌入已有软件。它不创建一个新的 Agent Loop，也不要求开发者重写自己的前端。

### 不是这些
- 不是新的大模型网关、LLM Provider Router 或通用 Agent 编排平台。
- 不是替代 Claude Code/Codex 的 CLI 或桌面 IDE。
- 不是绕过原厂登录、计费或授权的订阅共享器。
- V0 不是云端多租户 Agent 托管平台。

## 2. 目标客户与核心问题

| ICP | 当前做法 | 核心痛点 | Uncage 带来的价值 |
|---|---|---|---|
| 独立 SaaS / AI 产品开发者（首选） | 自己封装 CLI + 拼接 SSE + 搭 Chat UI | 审批、会话、错误、跨 Runtime 维护成本高 | 统一接入、现成 UI、可替换 Runtime |
| Electron / 本地桌面应用团队 | 各自启动 Coding Agent 子进程 | 权限、进程、事件、安装体验难以标准化 | Local Daemon + SDK + 审批组件 |
| 研发工具 / IDE 插件作者 | 对接专有 CLI / ACP | 不同 Runtime 的事件和可选能力不同 | Adapter + Capability Negotiation |
| 企业内部平台研发（第二阶段） | 自建 Agent 运行代理 | 审计、工作区与身份边界复杂 | 可部署的受控 Runtime Service |

**Beachhead**：已经有 Web/React 产品、希望在 1 天内嵌入完整 Agent 执行体验的 TypeScript 开发者。不要第一天就同时覆盖所有 IDE、所有语言和所有 Runtime。

## 3. Jobs-to-be-Done

用户故事：
1. 作为开发者，我希望通过一个 SDK 使用现有本机 Claude Code / Codex，无需实现 Agent Loop。
2. 我希望能显示消息、工具执行、文件变更、审批和运行状态，并保留自定义 UI 的能力。
3. 我希望在切换 Runtime 时保留相同的公共接口，同时清楚知道哪些能力不兼容。
4. 我希望在用户刷新页面或重连时恢复会话视图，不重复授权。

## 4. 品牌叙事

### 主叙事

**Your agent is powerful. Your app should be too.**

Claude Code 和 Codex 已经是强大的执行环境，但它们天然围绕自己的终端、IDE 和客户端。开发者想把这些执行能力嵌入已有产品时，还要重新处理会话、事件、授权、UI 和恢复。Uncage 负责连接这两个世界。

### Message House
- Headline: **Bring your agent to any app.**
- Proof 1: **Bring your runtime** — Claude Code / Codex via adapters.
- Proof 2: **Bring your UI** — drop-in React components or headless hooks.
- Proof 3: **Keep control** — local execution, scoped permissions, observable lifecycle.
- Proof 4: **Avoid lock-in** — stable common contract, explicit runtime-specific capabilities.

避免使用“完全兼容所有 Agent”“无需权限即可执行所有任务”“一行代码即可投入生产”等不可验证表述。

## 5. 定位与替代方案

| 方案 | 适合什么 | 与 Uncage 的不同 |
|---|---|---|
| Claude Agent SDK | 深度使用 Claude Code Harness | Uncage 提供多 Runtime 公共接口和 UI |
| Codex App Server | Codex 富客户端集成 | Uncage 提供跨 Runtime adapter 和统一前端 |
| ACP | Agent 与编辑器/客户端通信标准 | Uncage 是可部署/可嵌入的 SDK 产品，并可适配 ACP |
| AG-UI | Agent ↔ 前端事件和状态协议 | Uncage 复用/映射事件，并负责 Runtime 实例、审批和资源生命周期 |
| 自研 Agent Framework | 自己定义 Agent Loop、工具与编排 | Uncage 有意不重造底层 Harness |

ACP 和 AG-UI 都需要关注版本变更；本项目不把它们当作所有 Runtime 都原生支持的保证。

## 6. 首发产品承诺

开发者在支持的本地环境中完成：
1. 安装 Uncage 包并配置一个本机可用的 Runtime。
2. 创建 session、提交 prompt、订阅事件。
3. 在默认 React Chat 中看到消息、工具状态和审批卡片。
4. 点击允许/拒绝并确认回调生效。
5. 刷新浏览器后恢复可用的会话视图；支持情况由 capability 告知。
6. 把默认 UI 换成 headless hooks，不修改服务端业务协议。

### 不承诺
- 在任意操作系统、任意版本 Claude Code/Codex 上零配置启动。
- 跨 Runtime 迁移原生上下文或任务结果等价。
- 进程崩溃后精确恢复正在运行的工具调用。
- 所有登录方式或个人订阅都可合法用于商业 SaaS。

## 7. 官网首屏与 CTA（草案）

**Hero:** Bring your agent to any app.

**Subhead:** Plug Claude Code or Codex into your product with one runtime API, streaming events, and UI components you can actually customize.

**CTA 1:** Get started · **CTA 2:** View architecture

**Three steps:** Connect a runtime → Run a session → Ship your UI.

**Demo：**左侧切换 Claude Code / Codex，中间同一段会话，右侧显示工具执行、权限审批和文件 diff；明确标注模拟演示与真实执行的区别。

## 8. 发布节奏

| 阶段 | 出门条件 | 主要动作 | 衡量指标 |
|---|---|---|---|
| Private Alpha | 双 Adapter 完成端到端 golden path | 邀请 5–10 名开发者试用 | 成功跑通率、首个运行时间、审批故障数 |
| Public Beta | 文档、安装、恢复和安全检查达到门槛 | GitHub 发布、示例应用、技术文章、短 Demo | Weekly active projects、可复现 issue、示例完成率 |
| v1.0 | API 稳定、兼容矩阵、升级策略、审计与安全说明齐全 | 正式发布与社区内容 | 真实集成项目数、留存、贡献者数 |

不预设日期：每次发布由质量门槛触发。

## 9. 核心指标与仪表盘

- **Activation:** 安装后成功完成首个 agent run 的项目占比（首要指标）。
- Time-to-first-run（p50/p90），分操作系统、Runtime。
- 首个审批成功率，拒绝正确回传率。
- Session 重连成功率（按恢复级别区分）。
- 7 日活跃项目数、默认 UI vs Headless UI 采用率。
- Adapter 兼容版本覆盖率、每百次 run 的未分类错误数。

可选遥测必须默认关闭或充分告知；不能上传 prompt、文件内容、命令参数和密钥。

## 10. 渠道与内容计划

1. **GitHub**：完善 README、最短 Quickstart、架构边界和安全说明。
2. **文档站**：两条路线——5 分钟 Default UI，20 分钟 Custom UI。
3. **技术文章**：《Why we don't build another agent loop》《One approval UX for Claude Code and Codex》《What “session resume” really means》。
4. **Examples**：Next.js Chat、Electron、本地工具面板；所有示例需可复制运行。
5. **社区反馈**：公开兼容矩阵和 Roadmap，按真实集成阻碍排序 issue。

## 11. 授权和品牌风险

Uncage 为暂定名称。公开使用前必须完成商标、GitHub 组织、npm scope、主要域名及其他软件项目的冲突检查。第三方 Runtime 的许可证、凭据使用、订阅条款和服务化边界，由法务/产品在商业推广前验证。推荐优先发布工具本身，避免“提供共享模型额度”的商业叙事。

## 12. GTM 验收清单

- [ ] 有一句话定位、公开示例和真实运行视频
- [ ] 官方 README 在干净环境下可复现
- [ ] 兼容矩阵公开并覆盖明确版本
- [ ] 价格/许可/第三方责任边界清晰
- [ ] 至少 5 个非项目成员完成首个 run 并反馈
- [ ] 有可追踪的 activation、失败原因和 issue 入口

## 参考
- Claude Agent SDK permissions: https://code.claude.com/docs/en/agent-sdk/permissions
- Codex App Server: https://developers.openai.com/codex/app-server
- ACP: https://agentclientprotocol.com/
- AG-UI: https://docs.ag-ui.com/
