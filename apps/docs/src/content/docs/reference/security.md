---
title: Security
description: The security properties of Connected Mode (transport, machine tokens, device login, isolation between users, tool execution, file channel, limits) and Local Mode, and a checklist for website developers.
---

The [trust model](/docs/concepts/trust-model/) explains what a website may do on a user’s computer. This page lists how it is enforced.

## Transport

Protocol version `2`. The agent always connects **out**, so users need no open ports. The hub offers one or both transports (`transports` option); the agent uses WebSocket and falls back to HTTPS streaming after three failed attempts.

- **WSS** (traditional mode): one WebSocket per computer. The hub pings every 10 s; a computer that misses two pings is shown offline.
- **HTTPS streaming** (FaaS mode, and the fallback): `POST <basePath>/agent/connect` opens a link, `GET <basePath>/agent/stream` returns NDJSON lines (one JSON object per line: hub frames with a sequence number, and `{"ctl":"ping"}` every 10 s), and the agent sends its messages with `POST <basePath>/agent/events`. Every request carries the machine token as a `Bearer` header. The stream ends after `stream.maxDurationMs` and the agent reconnects at once. Reopening with a `cursor` acknowledges everything up to it, so a cut stream never loses a frame and never repeats an acknowledged one; upstream messages have idempotent ids, so a retry is not applied twice.
- Plain `ws://` / `http://` is refused unless the hub is on `localhost`, `127.0.0.1` or `[::1]` (development).
- Frames and request bodies are JSON, validated against the protocol schemas on both sides, at most 1 MiB each. The hub refuses agents older than `minAgentVersion` (WebSocket: `upgrade_required`; HTTP: `426 upgrade_required`).
- HTTP requests to `/agent/*`, WebSocket upgrades and `/machine/revoke` with a missing or wrong machine token are rate limited per client IP (`rateLimits.agentAuthFailuresPerMinute`, 60), counted in the store.
- Presence: a computer that stays silent for longer than two missed pings (about 30 s) is shown offline, on either transport.

## Machine tokens

- One token per computer and website: 32 random bytes, base64url.
- Stored only on the computer, in `~/.uncage/agent.yaml` (mode 0600; looser permissions are tightened). The hub stores a SHA-256 hash.
- Never logged, never put in events, never sent to the browser.
- Revocable from the website (`hub.revokeMachine`, `DELETE <basePath>/machines/:id`) and from the computer (`uncage sites remove`). A revoked token stops working at once and its connection is closed.
- Re-pairing the same computer (it sends a random `machineKey` at pairing) rotates the token and keeps the machine id; a connection using the old token is closed.

## Device login

- User codes: 8 characters from a 31-character alphabet without look-alikes (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`), valid 10 minutes, single use.
- Codes can only be approved by a signed-in user, through your `/device` page, which you must protect against framing and CSRF ([guide](/docs/guides/auth-and-device-approval/#the-approval-page-device)).
- Rate limits: 20 device codes per minute per client IP; 10 failed code lookups or decisions per user per 10 minutes. Counted in the hub store, shared by every node and function instance.
- The device code (the CLI’s polling secret) and the user code are stored hashed.

## Isolation between users

- Every browser request is authenticated with `getUser(req)`.
- Every session, run, approval, attachment and machine is looked up **with its owner**. Another user’s id answers `404`, indistinguishable from a missing one.
- A computer can only report events for its own sessions, and only call tools for runs of its own user’s sessions that were started through the hub.
- State-changing browser requests from another origin get `403 forbidden_origin`.

## Tool execution

- Tool handlers run **on your server**. The computer only receives names, descriptions and JSON Schemas.
- Tool names cannot contain `__` and are namespaced on the computer (`mcp__site__<name>`), so they can never shadow Claude Code’s built-in tools.
- Arguments are validated with your zod schema before the handler runs.
- A call is accepted only for tools in the run’s manifest; each call is audited in the hub store.
- `requiresConfirmation` tools ask the user on every call, in every permission mode.
- Timeouts (120 s), a concurrency cap (8 per computer) and a result size cap (just under 1 MiB) bound the work.

## File channel

- Paths must be relative and inside the session workspace; the computer resolves them with `realpath` and refuses anything outside.
- Symlinks are never followed. Hard-linked files are skipped in folder pulls and refused for single files.
- At most 50 MiB per pull and 10 MiB per file; pulls are all-or-nothing.

## On the user’s computer

- Each session runs in its own folder, `~/Uncage/<site host>/<session id>/` (mode 0700), never in existing projects. The browser cannot choose the folder.
- Skills are written only inside `.claude/skills/<name>/` of that folder, without following symlinks.
- `bypassPermissions` needs `localPolicy.allowBypass: true` on the computer; `localPolicy.allowedPermissionModes` caps the modes.
- Everything a website does is in `~/.uncage/sites/<site id>/activity.log` (redacted).
- `install.sh` has fixed content; it installs `@uncage/cli` from npm and nothing else.

## One-click connect

`uncage://connect?url=…` can be fired by any web page, so it never connects silently. The full model is in [One agent, every site](/docs/guides/one-click-connect/#threat-model); in short:

- **Phishing risk.** A hostile page could ask a computer to pair with the attacker’s site, where the attacker is signed in, and so bind the victim’s computer to the attacker’s account.
- **Native confirmation.** `uncage connect` shows a dialog outside the browser with the site’s registrable domain and full URL, defaulting to Cancel; without a dialog or a terminal it refuses. Warnings: international characters (punycode shown), bare IP, a specific page, first connection, and look-alikes of connected domains.
- **Strict links.** Only `https://` (or loopback `http`), no credentials, query or fragment, at most 2048 characters, one `url` parameter; one question at a time. After the confirmation the approval page and the answering site must match the confirmed origin.
- **Device flow unchanged.** The user still approves the code on the site’s `/device` page.
- **No registry.** Uncage does not vouch for any site; the dialog shows facts, not a verdict.
- **Handler scope.** Registered per user only (macOS app in `~/Library/Application Support`, a `.desktop` file in `~/.local/share/applications`, `HKCU` on Windows), no admin rights, removed by `uncage agent uninstall`.

### The local dashboard

`uncage dashboard` binds `127.0.0.1` on a random port. Each request needs the `Host` header `127.0.0.1:<port>` (DNS rebinding gets `403`), no foreign `Origin`, and a 32-byte secret: in the link once, then an `HttpOnly`, `SameSite=Strict` cookie. State changes are POSTs from the page’s own origin. No CORS headers, `X-Frame-Options: DENY`, `Cache-Control: no-store`. It closes with the page or after 30 minutes idle. Another local process or web page without the secret gets `403`; a process that can read your files can read `~/.uncage/agent.yaml` anyway.

## Apps and extensions

### App bearer tokens

- A native app sends `Authorization: Bearer <token>` and no `Origin`; the hub lets origin-less requests through the cross-site guard on every browser-API route, because only browsers attach cookies to cross-site requests and browsers always send `Origin`. A request with a foreign `Origin` is refused even with a valid cookie.
- Your `getUser` decides what a token is worth: issue expiring, revocable tokens, keep them in the keychain, and do not fall back to a cookie when a bearer header is invalid ([authenticate apps](/docs/guides/authenticate-apps/)).
- The app never holds a machine token and never talks to a computer directly.
- `trustedOrigins` (for extensions) are exact origins you control, validated by `createHub`: no wildcards, paths, `file:` or `null`, plain `http` on loopback only. A trusted origin may make state-changing requests with the user’s cookies.
- `POST /device/decision` accepts only `application/json`, and `GET /device/lookup` is behind the cross-site guard and the failed-code limit.
- Push tokens live in your database, never in the hub. `onAttention` fires at most once per event and skips events older than 10 minutes ([push notifications](/docs/guides/push-notifications/)).

## ACP agents

[Other ACP agents](/docs/guides/use-any-acp-agent/) run as local processes on the user’s computer, with their own login. What protects the user:

- **Consent is bound to the full spec.** An agent distributed through `npx` or `uvx` downloads code, so it runs only after `uncage runtimes enable <id>`. The consent records the runner, the package (any version), the arguments and the environment; if the registry later runs anything else, the agent waits for a new `enable`.
- **Registry trust.** An agent from the ACP registry is enabled only if it is installed on this computer and answers the ACP handshake. A registry refresh that changes the command withdraws it until you enable it again. `autoDetect: false` turns detection off; `disable` blocks an agent whatever else says so.
- **A project file cannot grant consent.** In Local Mode, `enable` and `consented` in `uncage.config.yaml` are ignored.
- **`agents[].command` in a project file runs without consent.** A project’s `uncage.config.yaml` can list any command, and `uncage serve` starts it. `uncage doctor` and `uncage serve` print every such command at start: only run them in projects you trust.
- **No “always”.** Uncage answers an ACP permission request with the agent’s `allow_once` or `reject_once` option and never selects `allow_always` or `reject_always`, which the agent could keep outside the session.
- **Site tools through a loopback MCP server.** Each run gets an MCP server on `127.0.0.1` with a one-time bearer token, passed to the agent in `mcpServers`; tools with `requiresConfirmation` ask in Uncage before every call. Handlers still run on your server.
- **Skills** are materialized only under `.uncage/skills/<name>/` of the session folder, and listed in the first prompt.
- The registry download (`cdn.agentclientprotocol.com`, at most daily; `UNCAGE_ACP_REGISTRY_REFRESH=0` turns it off) only supplies names, commands and icons: it runs nothing by itself.

## Local Mode

The daemon binds to loopback only, requires a bearer token from `~/.uncage/token` (mode 600), rejects foreign `Origin`s, and is reached by browsers only through your same-origin proxy, which checks `Host` (DNS rebinding) and `Origin`. Details: [Local Mode in depth](/docs/reference/local-mode/#security-model-local-mode).

## Checklist for website developers

- [ ] `getUser` returns the real signed-in user, or `null`; session cookies are `Secure` and `SameSite=Lax` or `Strict`.
- [ ] `publicUrl` is your `https://` origin, and your proxy forwards the original `Host`.
- [ ] `/device` requires sign-in, sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`, and decides with a CSRF-protected POST.
- [ ] Every tool handler scopes its reads and writes to `ctx.user.id`.
- [ ] Tool errors are user-safe; details go to your logs.
- [ ] Tools that publish, send, pay or delete use `requiresConfirmation: true`.
- [ ] Files pulled from computers are treated as untrusted (served sandboxed, scanned if needed).
- [ ] If you ship an app or extension: bearer tokens expire and are revocable, `trustedOrigins` lists only exact origins you control, and you do not expect users to confirm a one-click connection they did not start.
- [ ] The client IP is configured for rate limits behind your proxy.
- [ ] With your own Postgres pool or Redis client, `'error'` listeners are attached.
