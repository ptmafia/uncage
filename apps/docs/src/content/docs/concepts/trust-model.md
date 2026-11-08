---
title: Trust model
description: What a website using Uncage can and cannot do on a user's computer, what the user controls locally, and which guarantees are built in and cannot be switched off.
---

Connected Mode lets a website start work on a user’s own computer. That needs a clear answer to “what can the website do?”. Here it is.

## The short version

- **The website is trusted to act for its signed-in user.** What the user does on your website counts as the user’s own action: starting runs, approving cards, calling your tools as that user.
- **Within limits the website cannot change.** These are enforced on the user’s computer, by the agent, not by the hub:

| Guarantee | How |
| --- | --- |
| No code or shell from the website | The hub sends only data: tool names, descriptions and JSON Schemas, skill text and template files, and commands from a fixed list (create session, start run, cancel, decide, update settings, add attachment, read snapshot / sessions / events). Tool **handlers** run on your server, never on the user’s computer. |
| `bypassPermissions` only by the user | The agent refuses the mode with `policy_denied` unless `localPolicy.allowBypass: true` is set in `~/.uncage/agent.yaml` on that computer. No hub option can change this. |
| Optional local cap | `localPolicy.allowedPermissionModes` limits which modes any website may use on this computer. |
| Confirmation tools always ask | A site tool with `requiresConfirmation: true` raises an approval card on every call, even in `bypassPermissions` mode. |
| A full local record | Every command, site tool call, file pull and approval is appended to `~/.uncage/sites/<site id>/activity.log`. `uncage activity` shows it. |
| Fenced folders | Every session runs in its own folder, `~/Uncage/<site host>/<session id>/`, never in the user’s existing projects. File pulls are refused outside it, and symlinks are never followed. |
| The user can disconnect at any time | `uncage sites remove <id>` revokes the computer on the website and deletes the token locally; `uncage agent uninstall` stops the agent. |

## What the website can do

- Start sessions and runs on the user’s connected computers, as that user, with the permission modes the computer allows.
- Show the user approval cards and receive the user’s decisions.
- Offer site tools and skills. Claude Code decides when to call a tool; the call runs your handler on your server.
- Read files **from the session’s own folder** through the file channel, from inside a tool handler.
- Keep a replica of the conversation on its own storage (`sessionStorage: 'site'`).
- Revoke a computer from its side (`hub.revokeMachine` or the machine list in the UI).

## What the website cannot do

- Run anything on the user’s computer other than Claude Code (or Codex) itself, in a session folder.
- Turn on `bypassPermissions`, or use a mode outside the computer’s `allowedPermissionModes`.
- Choose where a session runs on disk. The browser’s `workspace` field is ignored in Connected Mode; the agent creates the folder.
- Reach another user’s computer or session. Every browser request is checked against `getUser(req)`, and a session or machine of another user answers `404`, exactly like one that does not exist.
- See the machine token. The hub stores only its hash; the token is never logged or put in events.
- Read the user’s Claude login. Claude Code uses its own credentials on that computer.

## What the user should know

These are the trade-offs the user accepts by connecting a computer:

- **Claude Code acts within the session folder and its permission mode, with the user’s own account.** In `default` mode the user approves commands and edits. Claude Code itself auto-allows some actions it considers safe, such as reading files. Those still appear as tool steps.
- **A command the user approves runs with the user’s rights**, like any Claude Code command. Approval cards show the command or path; read them.
- **The website sees the conversation** (it routes it, and may store it). It does not see other files on the computer unless Claude Code reads them into the conversation or a tool pulls them from the session folder.

## For website developers: your side of the deal

Uncage cannot protect against a website that misuses its own users’ trust, but it gives you the pieces to deserve it:

- **Authenticate every request.** `getUser(req)` must return the real signed-in user or `null`. See [Auth and device approval](/docs/guides/auth-and-device-approval/).
- **Protect `/device`.** Approving a code links a computer to an account. Serve it only to the signed-in user, refuse framing, and decide with a CSRF-protected POST.
- **Check ownership in tool handlers.** `ctx.user` is the session owner; use it for every lookup (`WHERE owner = ctx.user.id`).
- **Throw user-safe errors.** A handler’s thrown message is shown to the user and the model.
- **Use `requiresConfirmation`** for any tool that publishes, sends, pays or deletes.

See also [Security](/docs/reference/security/) for the transport, tokens and limits.
