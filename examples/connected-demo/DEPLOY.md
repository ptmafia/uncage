# Deploying the public demo / 部署公开演示

## 中文

下面以 Railway 为例，把 connected-demo 部署成公开演示（访客自动获得随机访客账号）。

1. Railway：New project → Deploy from GitHub repo，选择本仓库。
2. 打开服务的 Settings，把 Config-as-code 路径设为 `examples/connected-demo/railway.json`（它使用仓库根目录作为构建上下文，并指定 Dockerfile）。
3. 在 Variables 中添加：
   - `DEMO_PUBLIC=1`：开启公开模式（随机访客登录、横幅、页面请求仅限所有者，页面的子资源由无法猜测的资产 ID 保护；定期清理）。
   - `DOCS_URL=<站点>/docs/`：横幅里指向帮助站的链接。
   - `DEMO_SECRET`（可选）：至少 32 字节的 cookie 密钥；不设置则自动生成并存放在数据目录，重新部署后旧会话失效。
   - `PUBLIC_URL`：仅在使用自定义域名时设置（否则自动取 Railway 提供的域名）。
4. Networking → Generate Domain，得到公开地址。健康检查路径为 `/login`。

**什么会被清除、何时清除**

- 每次部署或重启：容器文件系统是临时的，Hub 数据、资产和自动生成的 cookie 密钥都会清空。
- 公开模式下，最后一次创建或发布超过 24 小时的资产会在启动时以及之后每小时被删除。

**可选：持久化。** 在服务上挂载一个 Volume，挂载路径为 `/data`（即 `DEMO_DATA_DIR`），数据即可跨部署保留；24 小时清理仍然生效。

**替代方案：Render。** 选择 Docker 部署，Dockerfile 为 `examples/connected-demo/Dockerfile`，构建上下文为仓库根目录，变量同上。免费套餐空闲后会休眠，首次访问较慢。

## English

These steps use Railway to host the connected demo as a public demo (visitors get a random guest account automatically).

1. Railway: New project → Deploy from GitHub repo, and pick this repository.
2. In the service's Settings, set the Config-as-code path to `examples/connected-demo/railway.json` (it builds from the repository root with the demo's Dockerfile).
3. Under Variables add:
   - `DEMO_PUBLIC=1`: turns on public mode (random guest sign-in, banner, page requests are owner-only; the page's sub-resources are guarded by the unguessable asset id; periodic cleanup).
   - `DOCS_URL=<site>/docs/`: the docs link shown in the banner.
   - `DEMO_SECRET` (optional): a cookie key of at least 32 bytes. If unset one is generated into the data dir, so sessions end on each redeploy.
   - `PUBLIC_URL`: only when you use a custom domain (otherwise the Railway domain is picked up automatically).
4. Networking → Generate Domain to get the public address. The health check path is `/login`.

**What is cleared, and when**

- On every deploy or restart: the container filesystem is ephemeral, so the hub's data, the assets and a generated cookie key are wiped.
- In public mode, assets last created or published more than 24 hours ago are deleted at start-up and then every hour.

**Optional: persistence.** Attach a Volume to the service mounted at `/data` (the `DEMO_DATA_DIR`) to keep data across deploys. The 24 hour cleanup still applies.

**Alternative: Render.** Create a Docker web service with the Dockerfile `examples/connected-demo/Dockerfile` and the repository root as build context, and set the same variables. The free tier sleeps when idle, so the first visit is slow.
