---
title: Local policy and the user's computer
description: 'What the end user controls on their own computer: ~/.uncage/agent.yaml and localPolicy (allowBypass, allowedPermissionModes), the activity log, folders, the background agent, disconnecting websites, and local extensions.'
---

This page is about the **user’s side**: the computer that runs `uncage agent`. Website developers should know it too, because it sets the limits of what your site can ask for. The reasons are in the [trust model](/docs/concepts/trust-model/).

## Files and folders

| Path | What |
| --- | --- |
| `~/.uncage/agent.yaml` | Connected websites (with their machine tokens) and `localPolicy`. Mode 0600; the agent tightens looser permissions. |
| `~/.uncage/sites/<site id>/data` | The local database of that website’s sessions (the source of truth) |
| `~/.uncage/sites/<site id>/activity.log` | What that website did on this computer (JSON lines) |
| `~/Uncage/<site host>/<session id>/` | One folder per session; Claude Code works here |
| `~/.uncage/logs/agent.log`, `agent.err.log` | The background agent’s output |
| `~/Library/LaunchAgents/dev.uncage.agent.plist` | The launchd service that keeps the agent running |

`UNCAGE_HOME=/absolute/path` moves `~/.uncage` and `~/Uncage` for development and tests (the background service cannot use it: run `uncage setup <url> --no-daemon`, then `uncage agent` in the foreground with the same variable). `HOME` is not changed, so Claude Code keeps its login.

## `~/.uncage/agent.yaml`

`uncage setup` creates and updates it. A typical file:

```yaml
# Uncage agent config. Holds machine tokens: keep it private (0600).
# localPolicy.allowBypass: true lets websites use bypassPermissions (only you can turn it on).
# localPolicy.allowedPermissionModes: optional list capping the modes websites may use.
sites:
  - id: app.example.com
    name: Example App
    url: https://app.example.com/api/uncage
    machineId: mch_3f9c…
    token: …            # secret: never share it
    machineKey: …
localPolicy:
  allowBypass: false
```

Only `localPolicy` is meant to be edited by hand. Your comments and `localPolicy` survive when `uncage setup` or `uncage sites remove` rewrite the `sites` list. Unknown keys are rejected with an error naming them.

### `localPolicy.allowBypass`

Default `false`. `bypassPermissions` lets Claude Code run any command and edit any file **without asking**. A website can offer the mode in its UI, but the agent refuses it with `policy_denied` (“bypassPermissions can only be enabled on this computer (localPolicy.allowBypass in ~/.uncage/agent.yaml)”) unless this is `true`. No website setting can change that.

```yaml
localPolicy:
  allowBypass: true
```

When it is on, the agent logs a warning at start. Tools marked `requiresConfirmation` still ask, even in bypass mode.

### `localPolicy.allowedPermissionModes`

An optional cap on the modes **any** website may use on this computer. A settings change to any other mode, or a run started in one, is refused with `policy_denied` (“Permission mode "…" is not allowed on this computer (localPolicy.allowedPermissionModes)”).

```yaml
localPolicy:
  allowBypass: false
  allowedPermissionModes: [default, plan]   # ask for everything, or plan only
```

Modes: `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions` (the last also needs `allowBypass: true`). New sessions start in `default`, so keep `default` in the list unless you want every run refused until the user picks an allowed mode.

### Apply a change

The agent reads `agent.yaml` when it starts. After editing, restart it:

```sh
launchctl kickstart -k gui/$(id -u)/dev.uncage.agent    # the background service
```

or stop and start `uncage agent` if you run it in the foreground.

## The activity log

Every command a website sends, every site tool call, every file pull and every approval is appended to `~/.uncage/sites/<site id>/activity.log`, along with connects, disconnects, revocations and upgrades.

```sh
uncage activity                       # every website
uncage activity --site app.example.com --follow
uncage activity --json                # one JSON object per line
```

The log is redacted: ids, states and error codes are kept; prompts, file contents and tool arguments are not.

## Websites

```sh
uncage sites                          # ID, NAME, HOST, MACHINE, STATUS
uncage sites remove app.example.com   # disconnect
```

`uncage sites remove` revokes this computer on the website (with its own token), removes the token from `agent.yaml`, and restarts the background agent. Local session data and workspaces are kept. If the website is unreachable, the token is removed anyway and the computer can still be revoked from the website’s side.

If a website revokes the computer, the agent marks the site `revoked` in `agent.yaml` and stops connecting to it. Run `uncage setup <url>` again to connect it again. (Running `uncage setup` for a website the computer is still connected to re-pairs it: it keeps its machine id and sessions and gets a new token.)

## The background agent

- `uncage setup <url>` installs it as a launchd user agent: it starts at login, and launchd restarts it after a crash or a self-upgrade (not after a clean exit, for example when no websites are left).
- `uncage agent uninstall` stops it and removes the service. `agent.yaml` and data stay.
- `uncage agent` runs it in the foreground (stop the service first). `UNCAGE_LOG_LEVEL=debug` for more output.
- Upgrades: if a hub requires a newer agent (`upgrade_required`), the agent runs `npm i -g @uncage/cli@latest` once, then restarts.
- One agent serves every connected website, each with its own connection, database and folders. Local Mode (`uncage serve`) can run on the same computer at the same time.

## Local extensions

Executable extensions (for example a hook that deploys a project when a run completes) may only ever come from **this computer**: an npm package the user installs or a local configuration the user writes. A website can only send data (tool schemas, skill text and templates), never code to run here. Uncage 0.2 does not ship a local extension API yet; `localPolicy` is the local control surface today.
