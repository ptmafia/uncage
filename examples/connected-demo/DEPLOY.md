# Deploying the public demo / 部署公开演示

Two ways to host the same code: **Railway** runs `server.ts` (traditional mode: one long-running process, WebSocket, no external services); **Vercel** runs the Next.js app without a custom server (FaaS mode: HTTP streaming, one Postgres). Either supports public mode.

同一份代码有两种托管方式：**Railway** 运行 `server.ts`（传统模式：一个常驻进程、WebSocket、无外部依赖）；**Vercel** 直接运行 Next.js、不需要自定义服务器（FaaS 模式：HTTP 流式传输、一个 Postgres）。两者都支持公开模式。

## 中文

下面以 Railway 为例，把 connected-demo 部署成公开演示（访客自动获得随机访客账号）。

1. Railway：New project → Deploy from GitHub repo，选择本仓库。
2. 打开服务的 Settings，把 Config-as-code 路径设为 `examples/connected-demo/railway.json`（它使用仓库根目录作为构建上下文，并指定 Dockerfile）。
3. 在 Variables 中添加：
   - `DEMO_PUBLIC=1`：开启公开模式（随机访客登录、横幅、页面请求仅限所有者，页面的子资源由无法猜测的资产 ID 保护；定期清理）。
   - `DOCS_URL=<站点>/docs/`：横幅里指向帮助站的链接。
   - `DEMO_SECRET`（推荐）：至少 32 字节的 cookie 密钥，用 `openssl rand -base64 48` 生成。不设置则自动生成并存放在数据目录，每次重新部署所有访客都会掉登录。
   - `TRUST_PROXY=1`：限流按 `X-Forwarded-For` 最右边一项识别访客。Railway 的边缘会覆盖这个请求头，所以最右边一项就是真实客户端。
   - `CLIENT_IP_HEADER`（可选，优先于 `TRUST_PROXY`）：从指定请求头取访客 IP。自定义域名经过 Cloudflare 代理时，`X-Forwarded-For` 里是 Cloudflare 的地址，所有访客会共用一个限流桶：这时在 Railway 上设 `CLIENT_IP_HEADER=x-real-ip`（或用 Cloudflare 的 `cf-connecting-ip`）。不经过代理直接 `docker run` 暴露容器时，两个都不要设，否则访客可以伪造自己的限流键。
   - `PUBLIC_URL`：仅在使用自定义域名时设置（否则自动取 Railway 提供的域名）。
   - `DEMO_MAX_TOTAL_MB`（可选，默认 200）：公开模式下所有访客发布的页面加起来最多占用的空间（MB）。达到上限后 `create_asset` / `publish_asset` 会告诉 AI 演示存储已满、请稍后再试。
4. Networking → Generate Domain，得到公开地址。健康检查路径为 `/login`。

**什么会被清除、何时清除**

- 每次部署或重启：容器文件系统是临时的，Hub 数据、资产和自动生成的 cookie 密钥都会清空。
- 公开模式下，最后一次创建或发布超过 24 小时的资产会在启动时以及之后每小时被删除。
- 公开模式下，每位访客最多同时保留 20 个资产（每个最多 20 MB）；超过后 `create_asset` 会拒绝，并提示复用已有资产或等待清理。
- 设置了 `DATABASE_URL` 时（例如多节点），资产存在 Postgres 而不是数据目录；旧版本存放在 `DEMO_DATA_DIR/assets` 的资产不会迁移。
- 公开模式下页面不显示“退出”：访客身份是找回已连接电脑和资产的唯一凭据，退出后再进入会得到一个新的访客。

**可选：持久化。** 在服务上挂载一个 Volume，挂载路径为 `/data`（即 `DEMO_DATA_DIR`），数据即可跨部署保留；24 小时清理仍然生效。容器以非 root 的 `node` 用户（uid 1000）运行，Volume 需要对它可写。

**替代方案：Render。** 选择 Docker 部署，Dockerfile 为 `examples/connected-demo/Dockerfile`，构建上下文为仓库根目录，变量同上。免费套餐空闲后会休眠，首次访问较慢。

### Vercel（FaaS 模式）

同一份代码不经过 `server.ts`，直接由 Next.js 路由 `app/api/uncage/[[...path]]/route.ts` 提供 Hub：电脑通过 HTTP 流式传输连接，所有状态（Hub、资产、限流计数）都在一个 Postgres 里，不需要 Redis，也不写本地磁盘。公开模式与 Railway 版等价。

1. 准备一个 Postgres（例如 Vercel Marketplace 里的 Neon）。每个函数实例只开一个连接池（`DATABASE_POOL_MAX`，默认 5 个连接，Hub、集群消息和资产共用），实例多了连接数仍会叠加，建议使用带连接池的连接串（Neon 的 `-pooler` 地址或 PgBouncer，事务模式即可）。
2. Vercel：Add New → Project，导入本仓库。Root Directory 设为 `examples/connected-demo`（保持勾选“Include files outside of the root directory”，它要用到 `packages/*`）。Framework 为 Next.js。
3. Build Command 设为 `cd ../.. && pnpm exec turbo run build --filter=connected-demo...`（先构建 demo 用到的工作区包，再 `next build`）。Install Command 保持默认（Vercel 识别 pnpm 工作区）。
4. 在 Environment Variables 中添加：
   - `ENABLE_EXPERIMENTAL_COREPACK=1`（必需）：让 Vercel 使用仓库 `packageManager` 字段固定的 pnpm 版本（pnpm 10）。
   - `DATABASE_URL`（必需）：Postgres 连接串。表在首次使用时自动创建。
   - `DEMO_SECRET`（必需）：至少 32 字节的 cookie 密钥，用 `openssl rand -base64 48` 生成。FaaS 模式没有数据目录可以存放自动生成的密钥，缺少它时 Hub 和登录都会拒绝启动，并说明缺了哪个变量。
   - `CRON_SECRET`（推荐）：Vercel Cron 调用 `/api/uncage/maintenance` 时带上的 `Authorization: Bearer` 密钥。不设置时该端点返回 404，只靠顺带清理。
   - `PUBLIC_URL`：用户打开、交给 `uncage setup` 的地址，例如你的自定义域名。在 Vercel 上不设置时取项目的生产域名（`VERCEL_PROJECT_PRODUCTION_URL`，即 `https://<项目>.vercel.app`）。在 Vercel、Railway、Render 以外以 FaaS 模式运行（`NODE_ENV=production`）时**必需**：缺少它时 Hub 和登录都会拒绝启动，而不是把 `http://localhost` 交给用户。
   - `DEMO_PUBLIC=1`：公开模式（随机访客登录、页面请求仅限所有者、每位访客最多 20 个资产且每次发布最多 5 MB、24 小时清理）。
   - `DEMO_MAX_TOTAL_MB`（可选，默认 200）：公开模式下所有访客的页面加起来最多占用的空间（MB）。资产和 Hub 共用同一个 Postgres，这个上限防止数据库被占满（例如 Neon 免费版约 0.5 GB）。
   - `DOCS_URL`（可选）：横幅里的帮助站链接。
   - 不要设置 `TRUST_PROXY` / `CLIENT_IP_HEADER`：在 Vercel 上自动使用其边缘写入的客户端地址（`x-real-ip`）。只有在 Vercel 前面还有别的代理或 CDN 时，才用 `CLIENT_IP_HEADER` 指向那个代理的客户端 IP 请求头。
   - `UNCAGE_STREAM_MAX_MS`（可选，默认 250000）：Hub 主动结束并轮换长连接的时间，必须小于路由的 `maxDuration`（300 秒）。如果你的套餐函数时长上限更低，把它调到上限以下。
5. Deploy。`vercel.json` 注册了每天一次的 Cron（`0 4 * * *` 调用 `/api/uncage/maintenance`）。

**清理在 Vercel 上怎么进行**

- Hobby 套餐的 Cron 每天只运行一次，所以主要靠顺带清理：请求到达时，Hub 最多每分钟在后台（Next 的 `after`，不拖慢响应）跑一次维护，并清除公开模式下超过 24 小时的资产。Cron 是兜底，保证没人访问时也会清理。
- 资产存在 Postgres（`demo_assets`、`demo_asset_files`，文件内容为 `bytea`），重新部署不会清空；24 小时清理照常生效。

**限制**

- 网页里发送的附件在 FaaS 模式下最大 4 MB：Vercel 在函数运行前就会拒绝超过约 4.5 MB 的请求体。电脑一侧的上传和文件拉取已经分块（每个请求体 ≤ 1 MB），不受这个限制。
- 存储：FaaS 模式下单次发布最多 5 MB（传统模式 20 MB），所以每位访客最多占用 20 × 5 MB = 100 MB（按 20 MB 算会是 400 MB）。Neon 免费套餐的存储只有约 0.5 GB，几位活跃访客就可能用满；24 小时清理会释放空间，但公开演示请留意数据库用量，或换更大的套餐。
- 每台在线的电脑大约占用一个持续运行的函数调用（下行流每 250 秒轮换一次）。少量同时在线的电脑在 Hobby 上可以运行；在线电脑多了，换成传统模式（Railway）更划算。

**验证清单**

- `curl https://<域名>/api/uncage/agent/info` 返回的 `transports` 只有 `http`。
- 以访客身份进入，按页面提示运行 `uncage setup https://<域名>`，在 `/device` 批准后电脑显示“在线”。
- 让 Claude Code 做一个落地页并发布：`publish_asset` 弹出批准卡片，`/assets` 里出现已发布的页面。
- 刷新对话，历史仍在；停止 `uncage agent` 后历史仍可读，电脑显示离线。
- `curl -H "Authorization: Bearer $CRON_SECRET" https://<域名>/api/uncage/maintenance` 返回 `{"ran":true,…}`（或在别的实例刚跑过时返回 `ran: false`）。

## English

These steps use Railway to host the connected demo as a public demo (visitors get a random guest account automatically).

1. Railway: New project → Deploy from GitHub repo, and pick this repository.
2. In the service's Settings, set the Config-as-code path to `examples/connected-demo/railway.json` (it builds from the repository root with the demo's Dockerfile).
3. Under Variables add:
   - `DEMO_PUBLIC=1`: turns on public mode (random guest sign-in, banner, page requests are owner-only; the page's sub-resources are guarded by the unguessable asset id; periodic cleanup).
   - `DOCS_URL=<site>/docs/`: the docs link shown in the banner.
   - `DEMO_SECRET` (recommended): a cookie key of at least 32 bytes; generate one with `openssl rand -base64 48`. If unset one is generated into the data dir, so every guest is signed out on each redeploy.
   - `TRUST_PROXY=1`: rate limits identify visitors by the rightmost `X-Forwarded-For` entry. Railway's edge overwrites that header, so the rightmost entry is the real client.
   - `CLIENT_IP_HEADER` (optional, wins over `TRUST_PROXY`): read the visitor's IP from this header. Behind a Cloudflare-proxied custom domain, `X-Forwarded-For` holds a Cloudflare address and all visitors share one rate-limit bucket: set `CLIENT_IP_HEADER=x-real-ip` on Railway (or Cloudflare's `cf-connecting-ip`). When you expose the container directly with `docker run` and no proxy, set neither, or visitors can choose their own rate-limit key.
   - `PUBLIC_URL`: only when you use a custom domain (otherwise the Railway domain is picked up automatically).
   - `DEMO_MAX_TOTAL_MB` (optional, default 200): in public mode, the space (MB) the pages of all visitors together may take. At the cap `create_asset` / `publish_asset` tell the AI the demo's storage is full and to try again later.
4. Networking → Generate Domain to get the public address. The health check path is `/login`.

**What is cleared, and when**

- On every deploy or restart: the container filesystem is ephemeral, so the hub's data, the assets and a generated cookie key are wiped.
- In public mode, assets last created or published more than 24 hours ago are deleted at start-up and then every hour.
- In public mode, each guest keeps at most 20 assets at a time (each up to 20 MB). Beyond that `create_asset` refuses and suggests reusing an existing asset or waiting for the cleanup.
- With `DATABASE_URL` set (for example multi-node), assets are stored in Postgres instead of the data dir; assets an older version kept in `DEMO_DATA_DIR/assets` are not migrated.
- In public mode there is no Log out: the guest identity is the only key to the linked computer and the assets, and signing in again mints a new guest.

**Optional: persistence.** Attach a Volume to the service mounted at `/data` (the `DEMO_DATA_DIR`) to keep data across deploys. The 24 hour cleanup still applies. The container runs as the unprivileged `node` user (uid 1000), so the volume must be writable by it.

**Alternative: Render.** Create a Docker web service with the Dockerfile `examples/connected-demo/Dockerfile` and the repository root as build context, and set the same variables. The free tier sleeps when idle, so the first visit is slow.

### Vercel (FaaS mode)

The same code runs without `server.ts`: the Next.js route `app/api/uncage/[[...path]]/route.ts` serves the hub, computers connect over HTTP streaming, and all state (hub, assets, rate-limit counters) lives in one Postgres. No Redis, nothing on local disk. Public mode works the same as on Railway.

1. Get a Postgres database (for example Neon from the Vercel Marketplace). Each function instance opens one pool (`DATABASE_POOL_MAX`, default 5 connections, shared by the hub, cluster messages and assets), but instances add up, so prefer a pooled connection string (Neon's `-pooler` host, or PgBouncer; transaction mode works).
2. Vercel: Add New → Project, and import this repository. Set Root Directory to `examples/connected-demo` (keep "Include files outside of the root directory" on: it needs `packages/*`). Framework: Next.js.
3. Set Build Command to `cd ../.. && pnpm exec turbo run build --filter=connected-demo...` (builds the workspace packages the demo uses, then `next build`). Leave Install Command at its default (Vercel detects the pnpm workspace).
4. Under Environment Variables add:
   - `ENABLE_EXPERIMENTAL_COREPACK=1` (required): makes Vercel use the pnpm version pinned in the repository's `packageManager` field (pnpm 10).
   - `DATABASE_URL` (required): the Postgres connection string. Tables are created on first use.
   - `DEMO_SECRET` (required): a cookie key of at least 32 bytes; generate one with `openssl rand -base64 48`. FaaS mode has no data dir to keep a generated key in, so without it the hub and sign-in refuse to start and name the missing variable.
   - `CRON_SECRET` (recommended): the `Authorization: Bearer` secret Vercel Cron sends to `/api/uncage/maintenance`. Without it that endpoint is a 404 and only the opportunistic cleanup runs.
   - `PUBLIC_URL`: the address users open and give to `uncage setup`, such as your custom domain. Unset on Vercel, the project's production domain is used (`VERCEL_PROJECT_PRODUCTION_URL`, i.e. `https://<project>.vercel.app`). **Required** when running in FaaS mode (`NODE_ENV=production`) anywhere other than Vercel, Railway or Render: without it the hub and sign-in refuse to start rather than hand users `http://localhost`.
   - `DEMO_PUBLIC=1`: public mode (random guest sign-in, owner-only page requests, at most 20 assets per guest and 5 MB per publish, 24 hour cleanup).
   - `DEMO_MAX_TOTAL_MB` (optional, default 200): in public mode, the space (MB) the pages of all visitors together may take. The assets share the hub's Postgres, so the cap keeps the database from filling up (Neon's free tier is about 0.5 GB).
   - `DOCS_URL` (optional): the docs link in the banner.
   - Do not set `TRUST_PROXY` / `CLIENT_IP_HEADER`: on Vercel the client address its edge sets (`x-real-ip`) is used automatically. Only with another proxy or CDN in front of Vercel, point `CLIENT_IP_HEADER` at that proxy's client-IP header.
   - `UNCAGE_STREAM_MAX_MS` (optional, default 250000): when the hub ends and rotates long-lived streams. Keep it below the route's `maxDuration` (300 s), and below your plan's function duration limit if that is lower.
5. Deploy. `vercel.json` registers a daily cron (`0 4 * * *` on `/api/uncage/maintenance`).

**How cleanup runs on Vercel**

- On the Hobby plan crons run only once a day, so the main path is opportunistic: as requests arrive, the hub runs maintenance at most once a minute in the background (Next's `after`, so no response waits for it), which also deletes public-mode assets older than 24 hours. The cron is the fallback for when nobody visits.
- Assets live in Postgres (`demo_assets`, `demo_asset_files` with the bytes in `bytea`), so a redeploy keeps them; the 24 hour cleanup still applies.

**Limits**

- Attachments sent through the website are capped at 4 MB in FaaS mode: Vercel refuses request bodies over about 4.5 MB before the function runs. Uploads and file pulls from the computer are already chunked (request bodies ≤ 1 MB), so they are unaffected.
- Storage: in FaaS mode one publish may pull at most 5 MB (20 MB in traditional mode), so a guest can hold up to 20 × 5 MB = 100 MB (it would be 400 MB at 20 MB). Neon's free tier has about 0.5 GB of storage, which a few active guests can fill; the 24 hour cleanup frees it again, but watch the database size on a public demo or use a larger plan.
- Each online computer keeps roughly one function invocation busy (its stream rotates every 250 s). A few computers online at once fit on Hobby; with many online, the traditional mode (Railway) is the cheaper choice.

**Verification checklist**

- `curl https://<domain>/api/uncage/agent/info` lists only the `http` transport.
- Enter as a guest, run `uncage setup https://<domain>` as the page says, approve on `/device`: the computer shows online.
- Ask Claude Code for a landing page and to publish it: `publish_asset` raises an approval card, and the published page appears on `/assets`.
- Reload the conversation: the history is there. Stop `uncage agent`: the history stays readable, the computer shows offline.
- `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/uncage/maintenance` returns `{"ran":true,…}` (or `ran: false` when another instance just ran it).
