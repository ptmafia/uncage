---
title: CLI reference
description: Every uncage command and flag, for Connected Mode (setup, agent, sites, activity) and Local Mode (serve, doctor), with the environment variables they read.
---

`@uncage/cli` installs the `uncage` command. End users get it from your site’s `install.sh` (or `npm i -g @uncage/cli`); Local Mode apps use it with `npx uncage …`. Every command has `--help`.

## Connected Mode (on the user’s computer)

### `uncage setup <url>`

```text
uncage setup <url> [--no-daemon] [--no-browser]
```

Connects this computer to a website. `<url>` is what your site shows: its origin, for example `https://app.example.com`. A URL with no path gets `/api/uncage` added (a hub on another base path shows its full URL, which is used as is); a URL with no scheme gets `https://`.

1. Requests a device code and prints the link and the code.
2. Opens the link in the browser (`open`), where the signed-in user approves.
3. Waits for approval, then saves the site and the machine token to `~/.uncage/agent.yaml` (mode 0600).
4. Installs and (re)starts the background agent (launchd: `~/Library/LaunchAgents/dev.uncage.agent.plist`).

| Flag | |
| --- | --- |
| `--no-daemon` | Do not install or start the background agent; run `uncage agent` yourself. |
| `--no-browser` | Do not open a browser; only print the link and the code (for a computer without a browser: open the link on another device). |

Plain `http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]`.

### `uncage agent`

```text
uncage agent              # run in the foreground
uncage agent uninstall    # stop and remove the background agent; config and data stay
```

Connects to every website in `~/.uncage/agent.yaml` and serves them. With no websites it exits cleanly. Stop the background service first if you want to run it by hand.

### `uncage sites`

```text
uncage sites                 # ID, NAME, HOST, MACHINE, STATUS
uncage sites remove <id>     # disconnect a website
```

`remove` revokes this computer on the website (`POST <hub>/machine/revoke` with its own token), removes the token from `agent.yaml` and restarts the background agent. Local session data (`~/.uncage/sites/<id>`) and workspaces (`~/Uncage/…`) are kept.

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

Optional `uncage.config.yaml` in the working directory: see [Local Mode in depth](/uncage/reference/local-mode/#configuration).

### `uncage doctor`

```text
uncage doctor [--port <n> | --url <url>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
uncage doctor --export-events <sessionId> [--out <file>] [--include-content] [--port <n> | --url <url>]
```

Checks Node, the data dir, the token, the running daemon and the runtimes (Claude Code, Codex). Every line is ✓ or ✗, and every ✗ prints a `fix:` command. It warns (`!`, non-fatal) when the daemon’s workspace is a git repository that does not ignore `.uncage/`, and before sending the token to a non-loopback URL.

`--export-events` writes a session’s events as JSON for a bug report; content is redacted unless `--include-content`.

The daemon is found via `--url`, `--port`, `UNCAGE_URL`, `UNCAGE_PORT`, `uncage.config.yaml`, then `4783`.

## Environment variables

| Variable | Used by | |
| --- | --- | --- |
| `UNCAGE_HOME` | Connected Mode commands | Absolute path that replaces `~` for `~/.uncage` and `~/Uncage` (development and tests). `uncage setup` refuses it unless `--no-daemon`. `HOME` is unchanged, so Claude Code keeps its login. |
| `UNCAGE_LOG_LEVEL` | `serve`, `agent` | Log level, e.g. `debug` |
| `UNCAGE_PORT` | `serve`, `doctor` | Daemon port |
| `UNCAGE_URL` | `doctor`, the Local Mode proxy | Daemon URL (default `http://127.0.0.1:4783`) |
| `UNCAGE_ALLOW_BYPASS=1` | `serve` | Offer `bypassPermissions` in Local Mode (prints a warning) |
| `UNCAGE_TOKEN` | the Local Mode proxy | The daemon token, if it is not in `~/.uncage/token` |
| `UNCAGE_ALLOWED_HOSTS` | the Local Mode proxy | Allowed `Host` names (comma-separated) |

In Connected Mode, bypass is controlled only by `localPolicy.allowBypass` in `~/.uncage/agent.yaml` ([local policy](/uncage/guides/local-policy/)).
