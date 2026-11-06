# 竞品与可参考项目调研

> 2026-11-06 · 基于公开网页/README 检索，未逐一实测；星数、版本以各仓库当前为准。

## 1. 结论速览

| 类别 | 项目 | 与 Uncage 的关系 |
|---|---|---|
| **直接竞品** | Rivet **Sandbox Agent SDK** | 定位高度重叠：统一 HTTP/SSE API + TS SDK + React 包 + 权限审批，覆盖 Claude/Codex/OpenCode/Cursor/Amp/Pi |
| 前辈（已归档） | coder **agentapi** | 靠终端模拟器解析 TUI 驱动各家 CLI；2026-09 归档，验证了需求但方案脆弱 |
| 协议层 | **ACP**（Zed `claude-code-acp` / `codex-acp`）、**AG-UI**（CopilotKit） | 可作为 Uncage 的下层/上层协议，而非对手 |
| 单 Runtime 官方 | Claude Agent SDK、Codex App Server、OpenCode `serve` + `@opencode-ai/sdk` | Uncage 的接入对象 |
| 前端框架 | CopilotKit（已有 Claude Agent SDK via AG-UI 指南）、assistant-ui、`react-acp` | 只解决 UI/协议，不管 Runtime 生命周期与本地安全 |
| 终端用户 App | T3 Code (MIT)、The Companion、CloudCLI/claudecodeui (AGPL)、claude-code-web、codex-webui | 产品形态不同（独立 App 而非可嵌入 SDK），可参考交互 |

## 2. Sandbox Agent SDK（重点）

- **架构**：Rust 静态二进制 server，跑在沙箱内（local 子进程 / Docker / E2B / Daytona / Vercel / Cloudflare），HTTP + SSE；每个 session 一个 agent 进程；从 `/v1/acp*` 路径与事件命名推断，底层走 ACP。
- **SDK**：`SandboxAgent.connect({baseUrl, token, persist})`、`sdk.createSession({agent, cwd, model, mode})`、`session.prompt([{type:'text',text}])`、`session.onEvent(cb)`、`sdk.resumeSession(id)`。
- **权限**：`session.onPermissionRequest(req)` + `session.respondPermission(id, 'once'|'always'|'reject')`，请求带 `availableReplies`。
- **事件**：ACP 风格 `sessionUpdate`（`agent_message_chunk`、`tool_call`/`tool_call_update`、`plan`、`usage_update`…），每 session `eventIndex`；未见 Last-Event-ID 式断线续传文档。
- **持久化**：交给 SDK 侧可插拔 `SessionPersistDriver`（InMemory / SQLite / Postgres / IndexedDB），server 不存历史；恢复时重放有限条数（默认 50 条 / 12000 字符）。
- **UI**：可选 `@sandbox-agent/react`、内置 Inspector（调试面板）。
- **成熟度**：Apache-2.0，~1.6k stars，v0.5.x，Rivet 公司维护。
- **安全**：建议 SDK 只在后端使用，token 不进浏览器。

## 3. Uncage 的差异化（仍成立的部分）

1. **嵌入已有 Web 应用的完整体验**：Sandbox Agent 偏“在沙箱里跑 agent 的基础设施”，Uncage 偏“把 agent 体验接进你的产品”——同源 BFF 代理、≤10 行默认 UI、Kumi 级默认界面、渐进式定制。
2. **审批的服务端一致性**：TTL、CAS 防双端重复、幂等 key、过期/取消/重启后的明确状态与审计事件；对方文档未体现这些。
3. **可靠的断线续传**：服务端持久化 + 连续 sequence + Last-Event-ID 完整重放；对方是 SDK 侧有限重放。
4. **本地优先安全模型**：loopback + token + Origin/Host 校验 + workspace realpath；对方以“沙箱隔离”为主。

**差异化不成立/需警惕的部分**：多 Runtime 统一 API 本身已不是独特卖点（对方覆盖更多 agent）；对方有公司背书和云沙箱生态。

## 4. 建议借鉴

| 借鉴点 | 来源 | 建议 |
|---|---|---|
| 审批回复 `once / always / reject` + `availableReplies` | Sandbox Agent、Codex | 协议里加 `availableDecisions`，V0 UI 仍只显示 once/deny |
| 可插拔持久化 driver | Sandbox Agent | 我们的 `Store` 接口已是此形态；文档化为公开扩展点 |
| Inspector 调试面板 | Sandbox Agent、agentapi `/docs` | P1：playground 内加原始事件查看器；server 暴露 `/openapi.json` |
| ACP 适配器 | Zed `claude-code-acp`/`codex-acp` | 后续加一个通用 `runtime-acp`，一次覆盖 Gemini/OpenCode 等；V0 保持原生 Claude/Codex |
| AG-UI 事件映射 | CopilotKit | 后续提供 `toAgUiEvents()`，让 CopilotKit 用户也能接 |
| **Codex 审批回包格式实证** | `lezi-fun/codex-webui`、`seo-rii/codex-webui`、T3 Code 源码 | 读其源码核对计划中标 UNVERIFIED 的 `protocol.ts` 字段 |
| 交互参考 | T3 Code（权限模式分级）、Companion（审批与追问） | 仅参考交互；CloudCLI 为 AGPL，不拷贝代码 |

## 5. 来源

- Sandbox Agent: https://rivet.dev/sandbox-agent/ · https://github.com/rivet-dev/sandbox-agent · https://rivet.dev/changelog/2026-01-28-sandbox-agent-sdk/
- agentapi: https://github.com/coder/agentapi
- OpenCode server/SDK: https://opencode.ai/docs/server/
- CopilotKit × Claude Agent SDK: https://docs.copilotkit.ai/claude-sdk-typescript
- ACP 客户端: https://github.com/hafbit/react-acp · https://awesome.ecosyste.ms/projects/github.com%2Fbeyond5959%2Fngent
- Vercel AI SDK 社区 provider: https://github.com/ben-vargas/ai-sdk-provider-claude-code
- Web UI: https://github.com/siteboon/claudecodeui · https://github.com/croll83/companion/pull/51 · https://github.com/fafawlf/claude-code-web · https://www.developersdigest.tech/blog/t3-code-open-source-gui-claude-code-codex-opencode-2026
