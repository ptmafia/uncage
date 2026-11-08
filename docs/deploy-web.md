# 上线清单：官网 + 帮助站（Vercel）与在线 demo（Railway）

官网（`/`、`/zh/`、`/ja/`）和帮助站（`/docs/`）是**一个** Vercel 静态部署；在线 demo 是一个 Railway 服务（需要常驻 Node 进程和 WebSocket，Vercel 托管不了）。两边互相引用对方的地址，所以按下面顺序做。

## 1. Vercel：官网 + 帮助站

推荐复用现在那个 `connected-demo` 项目（它的网址会从报错页变成官网）。也可以新建项目，设置相同。

1. 打开项目 → **Settings → General**：
   - **Project Name**：改成 `uncage`（网址变为 `uncage.vercel.app`，如果被占用就用分配到的名字）。
   - **Root Directory**：留空（仓库根目录 `./`）。
   - **Framework Preset**：`Other`。
   - **Build / Install / Output**：全部关掉 Override，由仓库根目录的 `vercel.json` 决定（`node scripts/build-web.mjs`，输出 `apps/site/dist`）。
   - **Node.js Version**：22.x 或更高。
2. **Settings → Environment Variables**（Production 和 Preview 都加）：
   - `SITE_URL` = 最终网址，例如 `https://uncage.vercel.app`（不带结尾 `/`）。用于 canonical、sitemap、OG 图、llms.txt。
   - `PUBLIC_DEMO_URL` = 第 2 步得到的 demo 地址（先不填也行，"在线体验"页会显示"本地运行 demo"的说明，不会出现死链）。
3. **Deployments → Redeploy**（或合并 PR 后自动部署）。
4. 可选：**Settings → Domains** 绑定自定义域名，然后把 `SITE_URL` 改成该域名并重新部署。

## 2. Railway：在线 demo

照 `examples/connected-demo/DEPLOY.md` 操作，要点：

1. New project → Deploy from GitHub repo → 选 `ptmafia/uncage`。
2. 服务 **Settings → Config-as-code** 路径填 `examples/connected-demo/railway.json`。
3. **Variables**：`DEMO_PUBLIC=1`、`DOCS_URL=<第 1 步的网址>/docs/`；可选 `DEMO_SECRET`（≥32 字节随机串，设了之后重新部署不会让访客掉登录）。
4. **Networking → Generate Domain**，得到 `https://xxx.up.railway.app`。
5. 回到 Vercel，把这个地址填进 `PUBLIC_DEMO_URL`，重新部署。

费用：Railway Hobby $5/月（含 $5 用量，demo 一般够用）。想零成本可用 Render 免费档（会休眠，冷启动约 30 秒，重启清数据）。

## 3. 收尾

- 原来的 GitHub Pages 部署已删除；组织里不需要再开 Pages。
- CI 里 "Docs" 工作流改名为 **Web**（只做构建与检查，不部署）。如果仓库设置了必需的状态检查（branch protection），把旧的 `build` / `Docs` 换成 `Web`。
- 验收：打开官网三种语言 → 点 "Docs" 进入对应语言的帮助站 → "在线体验" → 进 demo，用自己的电脑跑一遍。
