# Uncage — Claude Code 风格输入框（真实能力）设计

> 2026-11-06 · 前置：V0（`docs/superpowers/specs/2026-11-06-uncage-v0-design.md`）已完成并通过真实 Claude 验收。
> 本文冲突时以本文为准；V0 的安全模型、协议约定继续有效，除本文明确放开的部分。

## 1. 意图

用户要求默认输入框做成 Claude Code 桌面版那样（参考截图：大圆角输入框，占位文字在上；底部工具栏左侧 `+`、模型、推理强度、权限模式；右侧运行指示、麦克风、红色停止；输入框上方状态标签），并且**每个控件都必须是真实可用的能力**（“当然要真的可用啊，我们是要真正的能力 / 所有的都是”），用真实 Claude Code 端到端验收。代码改动统计（`+22.5k -70`）**不做**（用户明确）。

## 2. 验收（真实 Claude Code，Playwright live）

1. **模型**：下拉列出 Runtime 上报的模型（Claude 取自 SDK `supportedModels()`）；切换后下一次运行用新模型（以 SDK `system/init` 上报的 model 为证）。
2. **推理强度**：下拉 `low / medium / high / xhigh / max`（以 Runtime 上报为准），切换后下一次运行生效（传入 SDK `effort`）；Runtime 不支持时控件隐藏。
3. **权限模式**：`default`（每次询问）/ `acceptEdits`（自动接受编辑）/ `plan`（计划模式）/ `auto`（分类器自动审批）/ `bypassPermissions`（完全放行）。
   - `acceptEdits` 下写文件不弹审批卡；`default` 下弹；`plan` 下不执行写操作；`bypassPermissions` 下 Bash 也不弹卡。
   - `bypassPermissions` 只有服务端配置 `security.allowBypass: true` 时才出现；选择时弹确认框；开启后会话顶部持续显示警示条；服务端在未开启时拒绝该值（`policy_denied`）。
4. **附件**：`+` 按钮、拖拽、粘贴图片均可添加；图片（PNG/JPG/GIF/WebP）作为图片内容交给模型（真实验收：上传一张含特定文字的图片，模型回答中包含该文字）；文本类文件存入工作区 `.uncage/attachments/<sessionId>/` 并在消息中告知路径（真实验收：Agent 读取文件内容作答）。单个 ≤ 10 MB，一次 ≤ 10 个；超限/类型不支持给出明确提示。附件随消息进入历史，刷新后可见（缩略图/文件名）。
5. **语音输入**：麦克风按钮使用浏览器自带 Web Speech API 转文字填入输入框（支持中英文，跟随 `locale`）；浏览器不支持时按钮隐藏；首次使用提示“音频由浏览器厂商的语音服务处理”。验收以手工记录为准（自动化无法提供麦克风），另有组件测试覆盖不支持/识别结果填充。
6. **运行中标签**：输入框上方显示“N 个运行中”（所有会话中 active run 数），点击展开列表并可跳转会话；为 0 时隐藏。
7. 停止按钮、发送按钮、运行指示与 V0 行为一致，外观改为截图样式（红色圆形停止）。
8. Headless：以上能力全部通过 `@uncage/react` hooks 暴露，headless 示例至少接入模型、权限模式、附件三项。

## 3. 已定决策

| 项 | 决策 | 来源 |
|---|---|---|
| 范围 | 截图所有控件均真实可用；不做代码改动统计 | 用户 |
| 完全放行 | 包含 `bypassPermissions` | 用户 |
| 完全放行的保护 | 服务端 `security.allowBypass` 默认 false + 选择时确认 + 会话警示条 | 我方判断（用户已知悉） |
| 语音 | 浏览器自带 Web Speech API | 用户 |
| 附件规格 | 图片直传模型；文件落盘工作区并告知路径；10 MB / 10 个；随历史持久化 | 我方判断（用户已知悉） |
| 模型/强度生效时机 | 跟会话走，可中途切换，下一次运行生效 | 我方判断（用户已知悉） |
| 运行中标签 | 全部会话 active run 计数，可跳转 | 我方判断（用户已知悉） |

## 4. 实现要点（我方判断，实现者可调整细节）

- **协议**：
  - `RuntimeCapabilities` 增加 `models: {id,label,description?}[]`、`efforts: EffortLevel[]`、`permissionModes: PermissionMode[]`、`attachments: {images: boolean; files: boolean; maxBytes: number}`。
  - `Session` 增加 `settings: { model?: string; effort?: EffortLevel; permissionMode: PermissionMode }`（默认 `permissionMode: 'default'`）。
  - 新增 `PATCH /v1/sessions/:id/settings`（Zod 校验 + 能力校验 + bypass 策略校验）→ `session.updated`。
  - 新增 `POST /v1/sessions/:id/attachments`（原始 body + `Content-Type` + `X-Filename`，流式写盘，限额校验）→ `Attachment {id, name, mime, size, kind:'image'|'file', sha256}`；`GET /v1/attachments/:id`（缩略图/下载，需 token，经代理）。
  - `StartRunBody` 增加 `attachmentIds?: string[]`；`run.started` 的 `run` 携带附件元数据。
  - V0 全局约束“永不暴露 bypassPermissions”改为“仅在 `security.allowBypass` 时允许”。
- **Claude 适配器**：`model`、`effort`、`permissionMode`（bypass 时同时传 `allowDangerouslySkipPermissions: true`）进入 `query()` options；带图片时 prompt 改用 `AsyncIterable<SDKUserMessage>`，content 为 text + image（base64）块；`supportedModels()` 结果缓存用于 capabilities（probe 时取，失败回退到静态列表）。
- **Codex 适配器**：`model`、`effort`、`approvalPolicy`/`sandbox` 映射（`default`→`on-request`+`workspace-write`，`bypassPermissions`→`never`+`danger-full-access`，其余按协议可用值；不支持的模式不出现在 capabilities）；图片用 `localImage` 输入（mock 验证）。
- **存储**：PGlite 新表 `attachments`（元数据）；文件本体在工作区 `.uncage/attachments/<sessionId>/`（`.uncage/` 写入工作区 `.gitignore` 提示，不自动修改用户 `.gitignore`，doctor 给出提示）。路径经 realpath 校验位于工作区内。
- **代理**：`createUncageHandler` 支持 `PATCH` 与二进制 body 透传；附件下载透传 `Content-Type`。
- **UI（react-ui）**：Composer 重做为截图布局，沿用 Kumi 色板与字体（截图本身为浅灰白，与 Kumi 暖纸色接近；以 Kumi tokens 为准）；下拉用无依赖的 popover（键盘可达）；附件 chips 带缩略图与移除按钮；语音按钮录音时脉冲提示（尊重 reduced-motion）。
- **Hooks（react）**：`useSessionSettings()`（读/改）、`useAttachments()`（add/remove/upload 状态）、`useSpeechInput()`、`useRunningSessions()`。

## 4.1 细节裁定（我方判断，审阅后补充）

- **生效方式**：V0 每次运行都是新的 `query()` + `resume`，因此设置在下一次运行传入即可；不调用 `setModel/setPermissionMode` 改变进行中的运行。运行中允许修改设置，UI 提示“下一次运行生效”；已打开的审批卡不受影响。
- **`auto` 探测**：不做试跑探测；Claude capabilities 始终列出 `auto`，运行时若 SDK/CLI 报不支持，映射为 `unsupported_capability`（提示换模式）。
- **`allowBypass` 位置**：`uncage.config.yaml` 的 `security.allowBypass`（默认 false）+ 环境变量 `UNCAGE_ALLOW_BYPASS=1`；服务器级。关闭时 capabilities 的 `permissionModes` 不含 `bypassPermissions`，PATCH 该值返回 `policy_denied`。
- **附件存储**：图片和文件的本体都写入 `<workspace>/.uncage/attachments/<sessionId>/<attachmentId>-<安全文件名>`（每个会话都有工作区）；添加时即上传，发送时引用 id；未被任何消息引用且超过 24 小时的附件由保留任务清理；10 个上限按单条消息计。
- **迁移**：沿用 V0 PGlite `schema_migrations` 机制追加迁移。
- **文件类型**：按扩展名 + MIME 白名单：图片 png/jpg/jpeg/gif/webp；文件 txt/md/json/csv/yaml/yml/xml/html/css/js/ts/tsx/jsx/py/go/rs/java/rb/sh/sql/log/pdf（PDF 交给 Agent 的 Read 工具读取）。其他类型拒绝并提示支持列表。
- **运行中标签范围**：本服务器全部会话（V0 为本地单用户）。新增 `GET /v1/runs?active=1`；前端在页面可见时每 3 秒轮询一次，并在当前会话事件到达时即时刷新。
- **Codex**：所有新能力仅用 fake app-server 验证，兼容矩阵标注。

## 5. 非目标

代码改动统计；会话中途改工作区；附件的病毒扫描；离线语音（Whisper）；Codex 真机验证。

## 6. 风险

- `auto` 模式依赖 Claude 账号/版本能力，可能在某些账号不可用 → 以 SDK 报错映射为明确错误并在 capabilities 中探测后决定是否展示。
- `bypassPermissions` 下 Agent 可执行任意命令：默认关闭 + 明确警示；文档写清风险。
- Web Speech API 在 Chrome 中依赖联网与 Google 服务；不可用时隐藏。
