# Deploying the public demo / 部署公开演示

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
4. Networking → Generate Domain，得到公开地址。健康检查路径为 `/login`。

**什么会被清除、何时清除**

- 每次部署或重启：容器文件系统是临时的，Hub 数据、资产和自动生成的 cookie 密钥都会清空。
- 公开模式下，最后一次创建或发布超过 24 小时的资产会在启动时以及之后每小时被删除。
- 公开模式下，每位访客最多同时保留 20 个资产（每个最多 20 MB）；超过后 `create_asset` 会拒绝，并提示复用已有资产或等待清理。
- 公开模式下页面不显示“退出”：访客身份是找回已连接电脑和资产的唯一凭据，退出后再进入会得到一个新的访客。

**可选：持久化。** 在服务上挂载一个 Volume，挂载路径为 `/data`（即 `DEMO_DATA_DIR`），数据即可跨部署保留；24 小时清理仍然生效。容器以非 root 的 `node` 用户（uid 1000）运行，Volume 需要对它可写。

**替代方案：Render。** 选择 Docker 部署，Dockerfile 为 `examples/connected-demo/Dockerfile`，构建上下文为仓库根目录，变量同上。免费套餐空闲后会休眠，首次访问较慢。

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
4. Networking → Generate Domain to get the public address. The health check path is `/login`.

**What is cleared, and when**

- On every deploy or restart: the container filesystem is ephemeral, so the hub's data, the assets and a generated cookie key are wiped.
- In public mode, assets last created or published more than 24 hours ago are deleted at start-up and then every hour.
- In public mode, each guest keeps at most 20 assets at a time (each up to 20 MB). Beyond that `create_asset` refuses and suggests reusing an existing asset or waiting for the cleanup.
- In public mode there is no Log out: the guest identity is the only key to the linked computer and the assets, and signing in again mints a new guest.

**Optional: persistence.** Attach a Volume to the service mounted at `/data` (the `DEMO_DATA_DIR`) to keep data across deploys. The 24 hour cleanup still applies. The container runs as the unprivileged `node` user (uid 1000), so the volume must be writable by it.

**Alternative: Render.** Create a Docker web service with the Dockerfile `examples/connected-demo/Dockerfile` and the repository root as build context, and set the same variables. The free tier sleeps when idle, so the first visit is slow.
