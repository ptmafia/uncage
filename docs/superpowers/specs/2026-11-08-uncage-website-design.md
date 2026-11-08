# Uncage — 官网 + 帮助站（三语）+ 在线 demo 设计

> 2026-11-08 · 前置：0.2.0 已发布（11 个包）；帮助站 `apps/docs`（Astro Starlight）现部署目标是 GitHub Pages（未开通）；`examples/connected-demo` 被用户部署到 Vercel 但跑不起来（hub 需要 WebSocket 常驻进程）。

## 1. 意图

用户原话："run coding agent in everywhere……每个人都有自己很牛逼的工作环境，我想把每个人的工作环境服务化，有点 local harness as a service 的感觉。"

要一个**说明理念的官网**（logo、slogan、features、良好的信息架构），和帮助站一起作为**统一入口**，并能一键进入**临时在线 demo** 体验。必须"足够专业"，**支持中文、英文、日文**（官网和帮助站都要）。

受众：想把这种能力集成进自己产品的**开发者 / SaaS 团队**（用户确认）。

## 2. 目标 / 非目标 / 反目标

**目标**
- 官网首页按已确认的草图（`.superpowers/brainstorm/*/content/homepage-v1.html`，用户："整体感觉挺好的"）实现，三语。
- 帮助站全部手写页面三语齐全（en / zh-CN / ja），和官网同域、同视觉、互相跳转。
- 在线 demo 能在 Railway 上真实跑通（公开模式），官网 "Try the live demo" 指向它。
- 一个 Vercel 项目、一个域名承载官网 + 帮助站。

**非目标**
- 不做博客、定价页、登录、表单收集、埋点分析。
- 帮助站的 API 参考（typedoc 自动生成）只保留英文。
- demo 站自身的 UI 不做三语（保持现状中文，横幅之外不动）。
- 不改任何 npm 包的行为、不发版。

**反目标**（即使"能用"也算失败）
- 把未实现的能力写成已有：未实现的一律标 **Coming soon**（用户要求）。
- 机翻腔、术语前后不一致、三种语言内容不对等（某语言缺页 / 缺段）。
- 官网点 "Try the demo" 进到一个报错页（今天 Vercel 上的状态）。
- 看起来像模板站：必须有自己的视觉（Kumi 式暖纸色 + 橙色点缀）和精修 logo。

## 3. 已定决策

| 项 | 决策 | 来源 |
|---|---|---|
| Slogan | **Run your coding agent everywhere.** 副线：*Local harness, as a service.* | 用户理念；措辞为我方判断 |
| 受众 | 开发者 / SaaS 团队 | 用户 |
| 首页信息架构 | 导航 → Hero（slogan + 示意图 + 两个 CTA）→ Why（对比云端沙箱）→ How it works（三步）→ Features（已有 + Coming soon）→ 开发者代码片段 → Security → 收尾 CTA → 页脚 | 草图，用户认可 |
| 未实现能力 | 作为 feature 写，标 Coming soon：Codex 真机验证、Windows/Linux agent、更多入口（手机 / IM / 浏览器插件）、Serverless 传输（让网站能部署在 Vercel/Netlify） | 用户 + 我方补充（WS 讨论） |
| 语言 | en（默认）、zh-CN、ja；官网和帮助站都三语 | 用户 |
| 帮助站托管 | 只用 Vercel；删除 GitHub Pages 部署 | 用户 |
| demo 托管 | Railway（Dockerfile 通用，也能上 Render） | 用户 |
| 次要 CTA 文案 | **Integrate in minutes**（不写具体分钟数） | 用户 |
| 视觉 | Kumi 视觉语言：暖纸色底、墨色字、橙色点缀，与帮助站统一 | 已有记忆 + 草图 |

## 4. 我方判断（实现者可调整细节，但不改方向）

### 4.1 结构与托管
- **新增 `apps/site`**：Astro 静态站（与帮助站同栈，零运行时 JS 为主，仅语言切换 / 复制按钮等少量脚本）。
- **单域名单项目**：官网在 `/`，帮助站在 `/docs/`。帮助站 `base` 改为 `/docs`；构建时把 docs 的产物放进 site 产物的 `docs/` 子目录，Vercel 只部署一个输出目录（`apps/site/vercel.json` 或根目录 `vercel.json` 指定 build/output）。
  - 理由：一个入口、一个域名、无跨项目 rewrite、SEO 权重集中。
- 域名暂未定：一律从环境变量 `SITE_URL` 取（canonical、sitemap、OG、llms.txt 用），默认 Vercel 分配的域名。demo 地址从 `PUBLIC_DEMO_URL` 取；未设置时 "Try the demo" 指向帮助站的 "在线体验" 页（说明本地运行方式），不出现死链。
- `.github/workflows/docs.yml` 改为**只在 PR/main 上做构建检查**（snippet 类型检查 + 链接校验 + site 构建），不再部署 Pages。

### 4.2 官网 `apps/site`
- 路由：`/`（en）、`/zh/`、`/ja/`。首次访问 `/` 不自动跳转（利于 SEO 与分享），页头语言切换器 + 依据 `navigator.language` 的一次性非侵入提示条（可关闭、记住选择）。
- 每种语言：`<html lang>`、`hreflang` 互链 + `x-default`、独立 title/description、OG 图（三语各一张，构建时生成或静态 SVG→PNG）、`sitemap.xml`、`robots.txt`、`404`（三语）。
- 页面：首页（上述 IA）。导航项：Product（锚点）、How it works（锚点）、Security（锚点）、Docs（`/docs/` 对应语言）、Demo、GitHub。页脚链接文档、quickstart、API、llms.txt、GitHub、npm、Changelog、MIT。
- 首页示意图：静态 HTML/CSS 版本（同草图），带克制的入场与逐行出现动画，尊重 `prefers-reduced-motion`。
- 代码片段与真实 API 一致（`createHub`、`toNodeHandler`、`hub.attach`、`UncageProvider`、`AgentChat mode="connected"`、`defineTool`），并纳入类型检查（复用 docs 的 snippet 检查思路或在 site 内加同等检查）。
- 质量线：响应式（≥360px）、WCAG AA 对比度、键盘可达、Lighthouse（移动端）Performance / Accessibility / Best Practices / SEO 各 ≥ 95、无外部字体与第三方脚本（系统字体栈，含中日文字体回退）。
- 浅色为主；支持暗色（跟随系统）为加分项，若做必须同样精修。

### 4.3 Logo 与品牌
- 精修现有"打开的锁"图标（锁梁用橙色，表示 "uncaged"），配 **Uncage** 字标；输出：图标 SVG（明/暗）、横版组合 SVG、favicon（SVG + 32/180/512 PNG）、apple-touch-icon、OG 底图。帮助站同步替换 logo/favicon。
- 品牌色、字号、间距写成 CSS 变量，官网与帮助站共用一份 tokens（帮助站通过 Starlight 自定义 CSS 映射）。

### 4.4 帮助站三语
- Starlight locales：`root`（en）、`zh-cn`、`ja`。补齐所有手写页（当前 en 26 页；zh-cn 已有 6 页需按最新英文核对更新；其余 zh-cn 与全部 ja 新译）。API（generated）仅英文，侧边栏在 zh/ja 下指向英文 API。
- 侧边栏分组名三语（`nav.mjs` 增加 `ja`）。
- 所有内部链接从 `/uncage/...` 改为 `/docs/...`（注意不要误改 `/api/uncage/...` 这种产品路径）；`llms.txt` / `llms-full.txt` / `.md` 版页面 / `skills/uncage/SKILL.md` 路径随 base 更新；`llms*.txt` 只收英文（面向 coding agent）。
- 翻译规范：技术术语、代码标识符、命令、包名保持英文；按钮文字与产品 UI 实际显示一致（例如审批卡 "Allow once / Deny" 在中文 UI 为"允许执行 / 拒绝"，日文以实际 UI 为准——UI 没有日文时保留英文并注明）；每种语言一份术语表（hub、site tools、skills、Connected Mode、Local Mode、device approval 等的固定译法）放在 `apps/docs/i18n-glossary.md`，所有译文遵守。
- 代码块在所有语言中保持与英文一致（snippet 检查只需检查英文，译文代码块必须逐字相同——加一个检查脚本比对）。
- 新增页面 "Try the demo / 在线体验 / デモを試す"：在线 demo 地址（来自 `PUBLIC_DEMO_URL`）、两条命令、能体验到什么、数据会清空、本地运行 demo 的方法。

### 4.5 在线 demo（Railway）
已在分支 `feat/site-and-demo-deploy` 完成、待随本工作一起交付：
- `DEMO_PUBLIC=1` 公开模式：登录随机分配访客身份（防冒名驱动他人电脑）、顶部"临时体验环境"横幅 + `DOCS_URL` 回链。
- `publicUrl` 自动识别 `RAILWAY_PUBLIC_DOMAIN` / `RENDER_EXTERNAL_URL`；`TLS` 终止代理后 cookie 仍带 `Secure`。
- `examples/connected-demo/Dockerfile` + 根 `.dockerignore`（本地构建运行已验证）。
- 待补：`railway.json`、`DEPLOY.md`（Railway 一步步，含 Volume 挂 `/data`、环境变量表；Render 备选）；用容器 + 真实 Claude Code 跑通一次完整链路（setup → 对话 → 站点工具 → 审批 → 发布）。

## 5. 验收

1. `pnpm build` 后 site 产物含 `/`、`/zh/`、`/ja/`、`/docs/**`（三语）；本地 `vercel build` 或等价静态预览所有页面可访问、无 404 链接（链接校验覆盖 site → docs 跳转）。
2. 三语首页人工通读：无机翻腔、术语统一；Coming soon 项与实际能力相符。
3. 帮助站 en/zh-cn/ja 页面数一致（API 除外），代码块逐字一致检查通过，snippet 类型检查通过。
4. Lighthouse 移动端四项 ≥ 95（en 首页、ja 首页、一篇 docs 页）。
5. Playwright（系统 Chrome）截图：三语首页桌面 + 移动、docs 首页三语，交给用户验收。
6. demo 容器 + 真实 Claude Code 完整链路通过；`DEPLOY.md` 照做可在 Railway 上线。
7. 交付：推送分支 + 可直接打开的 PR（标题、描述）；Vercel / Railway 上需要用户点的步骤写成清单。

## 4.6 审阅后补充的裁定

- **仓库已公开**（2026-11-08 验证 github.com/ptmafia/uncage 可匿名访问；11 个包均在 npm 0.2.0）。GitHub 链接、editLink、"MIT / open source" 文案照常使用。
- **demo 数据清理**（我方判断）：Railway 上**不挂 Volume**，数据随每次重启 / 重新部署清空；另在公开模式下启动时与每小时清理一次超过 24 小时的会话、素材和访客数据（若 hub store 不便按时间删除，则只清理 demo 自己的素材目录，并在文案中只承诺"可能随时清空，至少每次部署都会清空"）。Dockerfile 去掉 `VOLUME /data` 声明（DEPLOY.md 说明想持久化时如何挂 Volume）。文案必须与实际行为一致。
- **demo 防滥用**（我方判断）：公开模式下 `/asset-files/**` 只对素材所有者可见（不再"有链接即公开"），避免被当作匿名网页托管；hub 自带的设备登录限流保持；每个素材 20 MB 上限保持。非公开模式行为不变。
- **无法安装 agent 的访客**（我方判断）：首页 "Try the live demo" 指向帮助站的"在线体验"页（而不是直接进 demo），该页先写清前提（macOS + Node 22 + 已登录的 Claude Code），提供真实运行的截图/流程演示（来自真实 E2E 截图，三语图注），再给 demo 入口与两条命令。不满足前提的访客也能看懂完整流程。
- **部署权限**：我方无法登录用户的 Vercel / Railway。我方在本地用 `docker` + 真实 Claude Code 验证容器，用本地静态预览验证站点；平台上需要点的步骤写成清单由用户执行。Vercel 建议**复用现有的 `connected-demo` 项目**（改 Root/Build/Output 设置并改名），这样已有的 `connected-demo-three.vercel.app` 不再是报错页。
- **只保留英文的页面**（我方判断）：API（generated）、`reference/changelog`、`guides/ci-and-releases`（贡献者文档）。zh-cn / ja 下侧边栏对这些页指向英文版并标注"English"。验收第 3 条的"页数一致"排除这三类。

## 6. 留给实现者

具体动画、插画细节、各段文案的最终措辞（在本文 IA 与语气内）、OG 图生成方式、构建脚本组织方式、暗色模式是否做。

## 7. 风险

- 日文质量：由我方撰写，建议上线后请母语者过一遍（交付时提示用户）。
- 翻译量大（约 26 页 × 2 语言）：并行分工，但必须统一术语表 + 代码块一致性检查兜底。
- Railway 免费额度不足以常驻：Hobby $5/月；或 Render 免费档（休眠、冷启动、重启清数据，作为临时 demo 可接受）。
