---
title: Security
description: The security properties of Connected Mode (transport, machine tokens, device login, isolation between users, tool execution, file channel, limits) and Local Mode, and a checklist for website developers.
---

The [trust model](/uncage/concepts/trust-model/) explains what a website may do on a user’s computer. This page lists how it is enforced.

## Transport

- The agent connects **out** to the hub over **WSS**. Plain `ws://` / `http://` is refused unless the hub is on `localhost`, `127.0.0.1` or `[::1]` (development). Users need no open ports.
- Frames are JSON, validated against the protocol schemas on both sides, at most 1 MiB each. Protocol version `1`; the hub refuses agents older than `minAgentVersion` with `upgrade_required`.
- The hub pings every 10 s; a computer that misses two pings is shown offline.

## Machine tokens

- One token per computer and website: 32 random bytes, base64url.
- Stored only on the computer, in `~/.uncage/agent.yaml` (mode 0600; looser permissions are tightened). The hub stores a SHA-256 hash.
- Never logged, never put in events, never sent to the browser.
- Revocable from the website (`hub.revokeMachine`, `DELETE <basePath>/machines/:id`) and from the computer (`uncage sites remove`). A revoked token stops working at once and its connection is closed.
- Re-pairing the same computer (it sends a random `machineKey` at pairing) rotates the token and keeps the machine id; a connection using the old token is closed.

## Device login

- User codes: 8 characters from a 31-character alphabet without look-alikes (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`), valid 10 minutes, single use.
- Codes can only be approved by a signed-in user, through your `/device` page, which you must protect against framing and CSRF ([guide](/uncage/guides/auth-and-device-approval/#the-approval-page-device)).
- Rate limits: 20 device codes per minute per client IP; 10 failed code lookups or decisions per user per 10 minutes. Counted per hub node.
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

## Local Mode

The daemon binds to loopback only, requires a bearer token from `~/.uncage/token` (mode 600), rejects foreign `Origin`s, and is reached by browsers only through your same-origin proxy, which checks `Host` (DNS rebinding) and `Origin`. Details: [Local Mode in depth](/uncage/reference/local-mode/#security-model-local-mode).

## Checklist for website developers

- [ ] `getUser` returns the real signed-in user, or `null`; session cookies are `Secure` and `SameSite=Lax` or `Strict`.
- [ ] `publicUrl` is your `https://` origin, and your proxy forwards the original `Host`.
- [ ] `/device` requires sign-in, sends `frame-ancestors 'none'` and `X-Frame-Options: DENY`, and decides with a CSRF-protected POST.
- [ ] Every tool handler scopes its reads and writes to `ctx.user.id`.
- [ ] Tool errors are user-safe; details go to your logs.
- [ ] Tools that publish, send, pay or delete use `requiresConfirmation: true`.
- [ ] Files pulled from computers are treated as untrusted (served sandboxed, scanned if needed).
- [ ] The client IP is configured for rate limits behind your proxy.
- [ ] With your own Postgres pool or Redis client, `'error'` listeners are attached.
