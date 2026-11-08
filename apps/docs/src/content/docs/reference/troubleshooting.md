---
title: Troubleshooting
description: Fixes for common problems installing on the computer (command not found, a removed Node.js, Linux lingering and no systemd, Windows execution policy, unzip), in Connected Mode (computer not connecting, offline, agent update needed, setup errors, tools not called, 504s and timeouts on serverless, cut connections, poolers, WebSocket behind proxies) and Local Mode (daemon not reachable, forbidden_origin, ports, sign-in).
---

## Installing on the computer

The one-command installers and the background agent on macOS, Linux and Windows. What they do: [Install on your computer](/docs/start/install-on-your-computer/).

### `uncage: command not found` after installing

Open a new terminal: the installer adds folders to `PATH` for new terminals only (macOS and Linux: the `# >>> uncage >>>` block in your shell profile; Windows: your user `Path`). If you answered **n** to “Use Node.js 22 as your default?”, the installer printed the full path of `uncage` and the `PATH` line to use; run that, or run the installer again and answer **Y**. With fish, add the line the installer printed to your config yourself.

### The background agent’s Node.js was removed

The service runs the exact Node.js it was installed with. A Homebrew upgrade (`brew upgrade node` or `node@22`) deletes the old version’s folder, and so does removing an nvm, fnm or other version-manager version. `uncage doctor` shows `✗ Background agent Node … no longer exists`. Pin the service to the Node.js you use now:

```sh
uncage agent install
```

### Linux: the agent stops when I log out

A systemd user service stops at logout unless lingering is on (`uncage doctor` warns). Turn it on for your user:

```sh
loginctl enable-linger $USER
```

Most distributions let you do this without `sudo`; if yours refuses, ask an administrator.

### Linux without systemd

In some containers and WSL setups there is no user systemd. `uncage setup` and `uncage agent install` then say so and install no service. Run the agent in the foreground, for example in `tmux` or `screen`:

```sh
uncage agent
```

### Windows: “running scripts is disabled on this system”

PowerShell’s default execution policy refuses `uncage.ps1`, the shim npm creates next to `uncage.cmd`. Run `uncage.cmd` instead (for example `uncage.cmd setup https://your.site`), or allow local scripts for your user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

The installer itself is not affected: `irm … | iex` runs without a script file.

### Linux: “installing fnm needs unzip”

With no Node.js version manager, the installer installs fnm, whose installer needs `unzip`. The installer never runs your package manager, so install `unzip` yourself (`sudo apt install unzip`, `sudo dnf install unzip`, …) and run the command again. Or install Node.js 22 any way you like and then run the command again.

## Connected Mode

### `uncage setup` fails or never finishes

- **“Refusing plain http for …”**: the agent accepts `http://` only for `localhost`, `127.0.0.1` and `[::1]`. Use your site’s `https://` URL.
- **The link opens but there is no Approve button**: the code is unknown, used or older than 10 minutes. Run `uncage setup <url>` again. Check that your `/device` page passes the `code` query parameter to `hub.lookupDevice`.
- **“Too many requests” / `rate_limited`**: too many codes from one IP (20 per minute), or too many wrong codes from one user (10 per 10 minutes). If it happens to many users at once, see the next section.
- **No browser on that computer**: `uncage setup <url> --no-browser` prints the link and the code; open the link on any device where the user is signed in.
- **`UNCAGE_HOME is for foreground runs`**: with `UNCAGE_HOME` set, use `--no-daemon` and run `uncage agent` yourself.

### `uncage setup` fails with `429 rate_limited` for many users at once

The device-code limit (20 per minute) is **per client IP**. Behind a reverse proxy, load balancer or CDN, the hub sees the proxy's address unless you configure the client IP, so every user lands in the same bucket and the 21st setup in a minute fails for everyone.

- **Express:** `app.set('trust proxy', 1)` (number of proxies in front), and mount the hub with `toNodeHandler(hub)`, which passes `req.ip`.
- **Next.js on Vercel:** `toNextHandlers` reads Vercel’s `x-real-ip` by itself; with another proxy in front of Vercel, pass its `clientIp` option.
- **Cloudflare Workers:** pass `clientIp: req.headers.get('cf-connecting-ip') ?? undefined` to `fetchOnce`.
- **Other Fetch-style servers (Hono, …):** `createHub({ rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined } })` with your platform's client-IP header, or pass `hub.fetch(req, { clientIp })`.
- **`rateLimits.trustForwardedFor: true`** only if your proxy appends the client address to `X-Forwarded-For`.

The count is kept in the store and shared by every node and function instance. Details: [behind a proxy](/docs/guides/mount-the-hub/#behind-a-reverse-proxy-or-load-balancer).

### The page keeps saying “Waiting for your computer…”

1. On the computer: `uncage sites` should list your site as `active`.
2. Is the agent running? `uncage agent status` shows the background service and the Node.js it runs with; or stop the service (`uncage agent uninstall`) and run `uncage agent` in a terminal to see its output. Logs: `~/.uncage/logs/agent.log` and `agent.err.log`.
3. What does the hub offer? `curl -s https://your.site/api/uncage/agent/info` must answer JSON with `"transports"`. An HTML page or a 404 means the hub is not mounted at that path.
4. Traditional mode: your server must call `attachWebSocket(hub, server)` on the same HTTP server that serves `publicUrl`, and every proxy in front should forward WebSocket upgrades on `<basePath>/agent`. (If upgrades fail, the agent switches to HTTP streaming after three attempts, so a blocked WebSocket alone no longer keeps a computer offline.)
5. FaaS mode: the agent must be 0.3 or newer (see [Agent update needed](#agent-update-needed--426-upgrade_required)), and the platform must stream responses (see [cut connections](#the-computer-keeps-reconnecting-or-streams-are-cut)).
6. `publicUrl` must be the URL users open. The install and setup commands, and the transport URLs the agent uses, come from it.

### The computer shows offline although the agent runs

- Laptop asleep or network changed: the agent reconnects with backoff (1 s up to 30 s). Runs continue locally and events backfill on reconnect.
- Idle timeouts on your load balancer below ~30 s drop the WebSocket. Raise them; the hub pings every 10 s.
- `uncage agent status` says the Node.js the service was installed with is missing (a Homebrew upgrade or a removed nvm/fnm version): run `uncage agent install` again.
- The computer was revoked from your site: `uncage sites` shows `revoked`. Run `uncage setup <url>` again.
- The agent is too old: see the next section.

### Agent update needed / 426 `upgrade_required`

The hub requires agent 0.3 or newer (`minAgentVersion`).

- **Traditional mode (WebSocket):** the hub tells the agent `upgrade_required`, and the agent upgrades itself with `npm i -g @uncage/cli@latest`, then reconnects. If npm needs `sudo` on that computer, the upgrade fails; fix npm’s global prefix (`npm config set prefix ~/.npm-global` and add its `bin` to `PATH`) and reinstall. Re-running your site’s install command does this for you.
- **FaaS mode (Vercel, Workers, …):** a 0.2 agent only speaks WebSocket, which a FaaS hub does not serve. It gets `426 upgrade_required`, the hub marks the computer as outdated, and the website shows **Agent update needed** on that computer’s card and in the chat (`<AgentOutdatedNotice>`, `MachineInfo.agentOutdated`). On that computer run:

  ```sh
  npm i -g @uncage/cli@latest
  uncage setup https://your.site
  ```

  `uncage --version` prints the CLI version on the first line and the Node.js it runs on on the second.

### 504 errors or “FUNCTION_INVOCATION_TIMEOUT” on serverless

A request outlived the platform’s time limit.

- **Agent streams and browser event streams:** set `stream.maxDurationMs` below the limit, with a margin (Vercel `maxDuration = 300` → `250_000`, the default). The hub then ends them itself and clients reconnect at once.
- **Site tool calls:** each runs inside one request, so `toolTimeoutMs` (120 s) must fit inside the limit too. A handler stopped by the platform fails with “Site tool "<name>" timed out on the website. Please try again.” and is not re-run.
- **Uploads:** a request body must arrive within `bodyTimeoutMs` (30 s); a slow upload is refused with `400`. Raise it for large attachments over slow links (and keep it under the limit).
- **Attachments over about 4.5 MB on Vercel** get Vercel’s own `413` before the hub runs. See [Vercel → FAQ](/docs/deploy/vercel/#attachments-over-about-4-mb-fail).

### The computer keeps reconnecting, or streams are cut

Cut connections are expected and harmless: the agent reconnects with its cursor, and nothing is lost or delivered twice. Look closer only if it never settles:

- **`http stream rotated` every few minutes** in the agent log is normal (the hub ends streams at `stream.maxDurationMs`).
- **Errors every few seconds**: something closes long requests early (a proxy or CDN timeout). Raise that timeout above `stream.maxDurationMs`, or lower `stream.maxDurationMs` below it.
- **Responses arrive all at once** (a prompt’s answer appears only at the end): a proxy buffers streams. Turn buffering off for `<basePath>/sessions/*/events` and `<basePath>/agent/stream` (nginx: `proxy_buffering off;`); the hub sends `X-Accel-Buffering: no` on agent streams, but not every proxy honours it.
- **`429` on `/agent/*`**: an agent with a wrong token (for example a revoked computer still running) hit `agentAuthFailuresPerMinute`. On that computer, `uncage sites` shows the site; run `uncage setup <url>` again.

### Postgres: poolers and serverless drivers

- **Transaction-mode poolers** (PgBouncer, Neon’s `-pooler` host) work with `postgresHubStore` and `postgresCluster`: migrations use transaction-scoped locks.
- **Neon’s `neon()` HTTP function fails**: the hub needs transactions on one connection. Use `pg` or Neon’s `Pool` from `@neondatabase/serverless`.
- **Too many connections**: every function instance opens its own pool. Use a pooled URL, and keep each pool small (`max: 5`), shared by the store and the cluster.
- **`Connection terminated` crashes a Node process**: attach `pool.on('error', …)` to any pool you create yourself.

### History disappears when the computer is off

That is `sessionStorage: 'machine'` (the default). Use `sessionStorage: 'site'` to keep a replica on your site ([Site storage](/docs/guides/site-storage/)).

### Claude Code does not call my tool

- It is not in the run’s manifest: check `selectManifest` (unknown names are ignored silently).
- The description does not tell the model when to use it. Say what it does and when, and mention it in a skill if it is part of a recipe.
- The session uses Codex (no site-tool support yet).
- In the chat, the tool step’s error tells you more: `invalid_request` (arguments did not match `input`), `tool_failed` (your handler threw, timed out or `not_in_manifest`).

### “Your computer is offline. Make sure the agent (`uncage agent`) is running on it.” / `machine_offline` when sending

The selected computer is offline. Pick another in the header’s computer menu, or start the agent.

### `/device` can be framed, or the approve button does nothing

See [Auth and device approval](/docs/guides/auth-and-device-approval/#the-approval-page-device): the page needs `frame-ancestors 'none'`, `X-Frame-Options: DENY`, and a POST decision that your framework accepts (a Next.js Server Action, or an endpoint with an Origin check).

### “The Uncage hub is not running: start the app with `node server.ts`”

You started `next dev`. The hub lives in the custom server; start it with `npm run dev` (`node server.ts`).

## Local Mode

### “The Uncage daemon is not reachable” / “token was not found”

Start `npx uncage serve` first. If the daemon was started with `--token-file`, give the app `UNCAGE_TOKEN`.

### 403 `forbidden_origin`

Read the message; it names the header.

- **“Host … is not allowed”**: the `Host` your browser sends is not an allowed hostname, for example you opened the `Network:` URL that `next dev` prints, a dev domain, or a tunnel. Add that hostname (without the port) to `allowedHosts` / `UNCAGE_ALLOWED_HOSTS`.
- **“Origin … does not match Host …”**: something between the browser and your app rewrites `Host`. Vite or webpack dev proxy: `changeOrigin: false`. nginx: `proxy_set_header Host $host;`.

In Connected Mode the same code means a cross-site POST reached the hub: the request’s `Origin` is neither `publicUrl` nor its own `Host`. Check that your proxy keeps `Host` and that `publicUrl` is exact (scheme and port included).

### Port 4783 in use

Another `uncage serve` is running, or use `--port 4784` and set `UNCAGE_URL=http://127.0.0.1:4784` for the app.

### Claude Code shows “auth required”

Run `claude`, type `/login`, then restart `uncage serve` (Local Mode) or the agent (Connected Mode).

## Still stuck?

- `npx uncage doctor` (Local Mode): every failing check prints its fix.
- `uncage activity --follow` (Connected Mode, on the computer): what the website asked for, and what failed.
- Open an issue with the `requestId` from the error and, for a session problem, `uncage doctor --export-events <sessionId> --out events.json` (Local Mode; content is redacted): [github.com/ptmafia/uncage/issues](https://github.com/ptmafia/uncage/issues).
