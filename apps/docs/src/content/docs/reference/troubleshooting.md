---
title: Troubleshooting
description: Fixes for common problems in Connected Mode (computer not connecting, offline, setup errors, tools not called, WebSocket behind proxies) and Local Mode (daemon not reachable, forbidden_origin, ports, sign-in).
---

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
- **Fetch-style servers (Hono, Next route handlers, …):** `createHub({ rateLimits: { clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined } })` with your platform's client-IP header, or pass `hub.handler(req, { clientIp })`.
- **`rateLimits.trustForwardedFor: true`** only if your proxy appends the client address to `X-Forwarded-For`.

With several nodes the limit is counted on each node. Details: [behind a proxy](/uncage/guides/mount-the-hub/#behind-a-reverse-proxy-or-load-balancer).

### The page keeps saying “Waiting for your computer…”

1. On the computer: `uncage sites` should list your site as `active`.
2. Is the agent running? `launchctl print gui/$(id -u)/dev.uncage.agent | head` (background service), or run `uncage agent` in a terminal to see its output. Logs: `~/.uncage/logs/agent.err.log`.
3. Can it reach the WebSocket? Your server must call `hub.attach(server)` on the same HTTP server that serves `publicUrl`, and every proxy in front must forward WebSocket upgrades on `<basePath>/agent`. A proxy that answers the upgrade with a plain 404 or 502 is the most common cause.
4. `publicUrl` must be the URL users open. The install and setup commands, and the WebSocket URL the agent derives from them, come from it.

### The computer shows offline although the agent runs

- Laptop asleep or network changed: the agent reconnects with backoff (1 s up to 30 s). Runs continue locally and events backfill on reconnect.
- Idle timeouts on your load balancer below ~30 s drop the WebSocket. Raise them; the hub pings every 10 s.
- The computer was revoked from your site: `uncage sites` shows `revoked`. Run `uncage setup <url>` again.
- The agent is too old (`upgrade_required` in its log): it upgrades itself with `npm i -g @uncage/cli@latest`. If npm needs `sudo` on that computer, the upgrade fails; fix npm’s global prefix (`npm config set prefix ~/.npm-global` and add its `bin` to `PATH`) and reinstall.

### History disappears when the computer is off

That is `sessionStorage: 'machine'` (the default). Use `sessionStorage: 'site'` to keep a replica on your site ([Site storage](/uncage/guides/site-storage/)).

### Claude Code does not call my tool

- It is not in the run’s manifest: check `selectManifest` (unknown names are ignored silently).
- The description does not tell the model when to use it. Say what it does and when, and mention it in a skill if it is part of a recipe.
- The session uses Codex (no site-tool support yet).
- In the chat, the tool step’s error tells you more: `invalid_request` (arguments did not match `input`), `tool_failed` (your handler threw, timed out or `not_in_manifest`).

### “Creating the session failed” / `machine_offline` when sending

The selected computer is offline. Pick another in the header’s computer menu, or start the agent.

### `/device` can be framed, or the approve button does nothing

See [Auth and device approval](/uncage/guides/auth-and-device-approval/#the-approval-page-device): the page needs `frame-ancestors 'none'`, `X-Frame-Options: DENY`, and a POST decision that your framework accepts (a Next.js Server Action, or an endpoint with an Origin check).

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
