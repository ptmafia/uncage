---
title: CLI reference
description: Every uncage command and flag, for Connected Mode (setup, agent install / uninstall / status, sites, runtimes, activity) and Local Mode (serve, doctor), uncage --version, the one-command installers, and the environment variables they read.
---

`@uncage/cli` installs the `uncage` command. End users get it from your site’s one-command installer, or with `npm i -g @uncage/cli`; Local Mode apps use it with `npx uncage …`. Every command has `--help`.

```sh
curl -fsSL https://your.site/api/uncage/install.sh | bash        # macOS, Linux
irm https://your.site/api/uncage/install.ps1 | iex               # Windows PowerShell
```

The installers check the computer (Node.js 22+, npm, an installed coding agent), ask `[Y/n]` before each step (Node.js through the user’s version manager when there is one; never `sudo` or admin rights), install `@uncage/cli`, and offer to run `uncage setup` for that website.

### `uncage --version`

```text
uncage --version
0.3.0
node v22.18.0 (/Users/ada/.local/share/fnm/node-versions/v22.18.0/installation/bin/node)
```

The first line is the CLI version; the second is the Node.js running it, with its path (what `uncage agent install` pins the background agent to).

## Connected Mode (on the user’s computer)

### `uncage setup <url>`

```text
uncage setup <url> [--no-daemon] [--no-browser]
```

Connects this computer to a website. `<url>` is what your site shows: its origin, for example `https://app.example.com`. A URL with no path gets `/api/uncage` added (a hub on another base path shows its full URL, which is used as is); a URL with no scheme gets `https://`.

1. Requests a device code and prints the link and the code.
2. Opens the link in the browser (`open`), where the signed-in user approves.
3. Waits for approval, then saves the site and the machine token to `~/.uncage/agent.yaml` (mode 0600).
4. Installs and (re)starts the background agent for this user, like `uncage agent install`: launchd on macOS (`~/Library/LaunchAgents/dev.uncage.agent.plist`), a systemd user service on Linux, a scheduled task on Windows. Where there is no service manager, it prints how to run `uncage agent` in the foreground.

| Flag | |
| --- | --- |
| `--no-daemon` | Do not install or start the background agent; run `uncage agent` yourself. |
| `--no-browser` | Do not open a browser; only print the link and the code (for a computer without a browser: open the link on another device). |

Plain `http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]`.

### `uncage agent`

```text
uncage agent [--log-file <path>]   # run in the foreground
uncage agent install               # install and start the background agent for this user
uncage agent uninstall             # stop and remove the background agent; config and data stay
uncage agent status [--json]       # installed? running? which Node.js?
```

`uncage agent` connects to every website in `~/.uncage/agent.yaml` and serves them, over WebSocket or HTTP streaming, whichever each website offers. With no websites it exits cleanly. Stop the background service first if you want to run it by hand.

| Flag / subcommand | |
| --- | --- |
| `--log-file <path>` | Append the logs to this file instead of stderr. Log files are capped at every start. |
| `install` | Installs and starts the per-user background service, **pinned to the Node.js running this command** (its real path, not a version-manager shim): launchd on macOS, a systemd user service on Linux, a scheduled task (current user, least privilege; a registry Run entry if the task cannot be created) on Windows. No admin rights. Run it again after you change or remove that Node.js. Refused while `UNCAGE_HOME` is set. |
| `uninstall` | Stops and removes the service. `~/.uncage/agent.yaml` and the data stay. |
| `status` | The service kind, whether it is installed and running, its definition file, the pinned Node.js (and whether it still exists), the CLI entry and the logs folder (`~/.uncage/logs`). `--json` prints the same as JSON. |
| `--supervise` | Internal: the Windows scheduled task runs `uncage agent --supervise`, which restarts the agent after a crash or a self-upgrade (Task Scheduler does not). Not needed on macOS and Linux. |

On Linux, a user service stops at logout unless lingering is on: `uncage doctor` tells you, and `loginctl enable-linger $USER` fixes it. Linux and Windows are CI verified, awaiting real-device confirmation; macOS is verified on real devices.

### `uncage sites`

```text
uncage sites                 # ID, NAME, HOST, MACHINE, STATUS
uncage sites remove <id>     # disconnect a website
```

`remove` revokes this computer on the website (`POST <hub>/machine/revoke` with its own token), removes the token from `agent.yaml` and restarts the background agent. Local session data (`~/.uncage/sites/<id>`) and workspaces (`~/Uncage/…`) are kept.

### `uncage runtimes`

```text
uncage runtimes [--json] [--all] [--refresh]   # ID, NAME, STATUS, VERSION, SITE TOOLS, RESUME
uncage runtimes enable <id>                    # register an ACP registry agent (consent for npx/uvx)
uncage runtimes disable <id>                   # never register an ACP agent
```

Lists the runtimes `uncage agent` offers to websites: Claude Code, Codex and the ACP agents from `runtimes.acp` in `~/.uncage/agent.yaml` (presets, your own entries and agents detected from the ACP registry), with their status and whether they support site tools and resume. Then it lists ACP registry agents that are not registered and why.

| Flag | |
| --- | --- |
| `--json` | `{ runtimes, registry }` as JSON |
| `--all` | Also list registry agents that are not installed here |
| `--refresh` | Download the latest ACP registry first (otherwise the cached or bundled copy) |

`enable` prints exactly what will run and records your consent in `runtimes.acp.enable` / `consented`; agents distributed through `npx` or `uvx` never run without it. `disable` adds the id to `runtimes.acp.disable`. Both restart the background agent. See [Use any ACP agent](/docs/guides/use-any-acp-agent/).

### `uncage activity`

```text
uncage activity [--site <id>] [--follow] [--json]
```

Shows what connected websites asked this computer to do: every command, site tool call, file pull and approval, plus connects, disconnects, revocations and upgrades. Redacted: ids, states and error codes are kept; prompts, file contents and tool arguments are not.

| Flag | |
| --- | --- |
| `--site <id>` | Only this website (see `uncage sites`) |
| `--follow`, `-f` | Keep printing new entries |
| `--json` | One JSON object per line |

## Local Mode (on the machine that runs your app)

### `uncage serve`

```text
uncage serve [--port <n>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
```

Starts the local daemon on `127.0.0.1` (loopback only).

| Flag | Default |
| --- | --- |
| `--port <n>` | `4783`, or `UNCAGE_PORT` |
| `--workspace <dir>` | The current directory. The folder the agent reads and edits. |
| `--data-dir <dir>` | `~/.uncage/data` (sessions and events) |
| `--token-file <file>` | `~/.uncage/token` (the bearer token, created with mode 600) |

Optional `uncage.config.yaml` in the working directory: see [Local Mode in depth](/docs/reference/local-mode/#configuration).

### `uncage doctor`

```text
uncage doctor [--port <n> | --url <url>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
uncage doctor --export-events <sessionId> [--out <file>] [--include-content] [--port <n> | --url <url>]
```

Checks Node, the data dir, the token, the running daemon, the background agent of Connected Mode (installed and running, its pinned Node.js still present, Linux lingering, each connected website’s agent version) and the runtimes (Claude Code, Codex, and one `runtime.acp-<id>` row per ACP agent, configured in `runtimes.acp` of `uncage.config.yaml` or detected). Every line is ✓ or ✗, and every ✗ prints a `fix:` command. ACP rows are optional: a ✗ there (for example not installed, with its install hint as the fix) does not change the exit code. Every ACP agent that `uncage.config.yaml` adds with its own `command` also gets a warning row showing the command it runs. It warns (`!`, non-fatal) when the daemon’s workspace is a git repository that does not ignore `.uncage/`, and before sending the token to a non-loopback URL.

`--export-events` writes a session’s events as JSON for a bug report; content is redacted unless `--include-content`.

The daemon is found via `--url`, `--port`, `UNCAGE_URL`, `UNCAGE_PORT`, `uncage.config.yaml`, then `4783`.

## Environment variables

| Variable | Used by | |
| --- | --- | --- |
| `UNCAGE_HOME` | Connected Mode commands | Absolute path that replaces `~` for `~/.uncage` and `~/Uncage` (development and tests). `uncage setup` refuses it unless `--no-daemon`. `HOME` is unchanged, so Claude Code keeps its login. |
| `UNCAGE_LOG_LEVEL` | `serve`, `agent` | Log level, e.g. `debug` |
| `UNCAGE_ACP_REGISTRY_REFRESH=0` | `agent` | No daily download of the ACP registry (the cached or bundled copy is used) |
| `UNCAGE_PORT` | `serve`, `doctor` | Daemon port |
| `UNCAGE_URL` | `doctor`, the Local Mode proxy | Daemon URL (default `http://127.0.0.1:4783`) |
| `UNCAGE_ALLOW_BYPASS=1` | `serve` | Offer `bypassPermissions` in Local Mode (prints a warning) |
| `UNCAGE_TOKEN` | the Local Mode proxy | The daemon token, if it is not in `~/.uncage/token` |
| `UNCAGE_ALLOWED_HOSTS` | the Local Mode proxy | Allowed `Host` names (comma-separated) |

In Connected Mode, bypass is controlled only by `localPolicy.allowBypass` in `~/.uncage/agent.yaml` ([local policy](/docs/guides/local-policy/)).
