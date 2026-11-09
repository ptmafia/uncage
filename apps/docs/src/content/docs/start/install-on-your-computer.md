---
title: Install on your computer
description: The one command a website shows to connect your computer, on macOS, Linux and Windows. What it checks and installs, which Node.js version managers it uses, the background service, flags, non-interactive runs, manual install and uninstall.
---

A website built with Uncage shows one command to connect your computer. The command checks the computer and asks `[Y/n]` before each thing it installs: Node.js 22 (with your own version manager when you have one), then the Uncage CLI. It lists the coding agents it finds and then offers to run `uncage setup` for that website, which opens the browser so you can approve the computer. It never uses `sudo` or admin rights, and it never changes your default Node.js unless you say yes.

One-click connect to more sites needs `@uncage/cli` 0.4 or newer. If you installed 0.3, run `npm i -g @uncage/cli@latest` and then `uncage agent install` (or `uncage setup`) again: that is the only place the `uncage://` handler is registered.

The examples use `https://your.site`; copy the command the website shows, which has its own address.

## macOS

```sh
curl -fsSL https://your.site/api/uncage/install.sh | bash
```

Run it in Terminal. The answers come from your keyboard even though the script arrives through a pipe.

### What it checks and installs

1. **The computer.** macOS on Apple silicon or Intel. Anything else stops with exit code 3.
2. **Node.js 22 or newer.** If `node` is older or missing, it installs Node.js 22 with the first version manager it finds (see the table below). Without one, it uses Homebrew (`brew install node@22`, which is keg-only and does not replace your `node`), and without Homebrew it installs fnm into `~/.local/share/fnm`. Then a separate question: “Use Node.js 22 as your default Node.js?” With **n**, your default stays as it is and the script uses Node.js 22 by its full path.
3. **npm’s global folder.** If it is not writable without `sudo`, the script offers to move it to `~/.npm-global` (never for an nvm Node, which does not allow it).
4. **The Uncage CLI.** `npm install -g @uncage/cli` with the version range the website asks for.
5. **Coding agents.** Claude Code, Codex and ACP agents that are installed. With none, it prints how to install Claude Code and stops; run the command again afterwards.
6. **Setup.** It offers to run `uncage setup https://your.site`.

PATH changes go into one marked block (`# >>> uncage >>>` … `# <<< uncage <<<`) in the profile of your shell: `~/.zshrc` for zsh, `~/.bash_profile` for bash, `~/.profile` otherwise. For fish it prints the line to add. Open a new terminal afterwards.

### Version managers

The first one found is used, in this order. Node.js 22 is installed without becoming the default; the default changes only after a separate yes.

| Version manager | Installs Node.js 22 with | After “yes” to the default |
| --- | --- | --- |
| nvm | `nvm install 22` | `nvm alias default 22` |
| fnm | `fnm install 22` | `fnm default 22` |
| mise | `mise install node@22` | `mise use -g node@22` |
| asdf | `asdf install nodejs latest:22` (adds the `nodejs` plugin if missing) | `asdf set -u nodejs <version>` (`asdf global` on asdf before 0.16) |
| volta | `volta fetch node@22` | `volta install node@22` |
| n | `n download 22` | `n 22` |

volta is unmaintained upstream: an existing volta is used, but the script never installs it. nvm and fnm make the first version they install the default by themselves; when you answer **n**, the script undoes that.

### Background service

`uncage setup` installs the agent as a launchd user agent (`~/Library/LaunchAgents/dev.uncage.agent.plist`). It starts at login and is restarted after a crash or a self-upgrade. It runs the exact Node.js it was installed with. `uncage agent status` shows it.

A Homebrew upgrade (`brew upgrade node` or `node@22`) or removing an nvm / fnm version deletes that Node.js. `uncage doctor` then says so; run `uncage agent install` again.

### Uninstall

```sh
uncage agent uninstall
uncage sites remove <id>
npm uninstall -g @uncage/cli
```

`uncage sites` lists the ids. Then remove `~/.uncage` and `~/Uncage` if you no longer want the data and the session folders, and delete the `# >>> uncage >>>` block from your shell profile. Node.js stays; remove it with your version manager if you want.

## Linux

```sh
curl -fsSL https://your.site/api/uncage/install.sh | bash
```

### What it checks and installs

The same steps as on macOS, on x64 and arm64. Without a version manager, it installs fnm into `~/.local/share/fnm`; fnm’s installer needs `curl` and `unzip`, and without `unzip` the script stops with the commands to run (it never calls your package manager). The PATH block goes into `~/.zshrc` for zsh, `~/.bashrc` for bash, `~/.profile` otherwise.

### Version managers

The same order and commands as on macOS: nvm, fnm, mise, asdf, volta, n. There is no Homebrew fallback; without a version manager, fnm is installed in your home folder.

| Version manager | Installs Node.js 22 with | After “yes” to the default |
| --- | --- | --- |
| nvm | `nvm install 22` | `nvm alias default 22` |
| fnm | `fnm install 22` | `fnm default 22` |
| mise | `mise install node@22` | `mise use -g node@22` |
| asdf | `asdf install nodejs latest:22` | `asdf set -u nodejs <version>` |
| volta | `volta fetch node@22` | `volta install node@22` |
| n | `n download 22` | `n 22` |

### Background service

`uncage setup` installs a systemd user service, `~/.config/systemd/user/uncage-agent.service` (`Restart=on-failure`), pinned to the Node.js it was installed with. `uncage agent status` shows it.

A user service stops when you log out unless lingering is on. `uncage doctor` tells you; this keeps the agent running:

```sh
loginctl enable-linger $USER
```

Without a user systemd (some containers and WSL setups), there is no service: run `uncage agent` in the foreground, for example in `tmux`.

### Uninstall

```sh
uncage agent uninstall
uncage sites remove <id>
npm uninstall -g @uncage/cli
```

Then remove `~/.uncage`, `~/Uncage` and the `# >>> uncage >>>` block from your shell profile if you want.

## Windows

```powershell
irm https://your.site/api/uncage/install.ps1 | iex
```

Run it in PowerShell (Windows PowerShell 5.1 or PowerShell 7), as your normal user.

### What it checks and installs

1. **The computer.** Windows on x64 or arm64.
2. **Node.js 22 or newer**, with nvm-windows, fnm or volta when one is installed. Without one, it installs fnm for your user: with winget (`winget install --id Schniz.fnm`, a per-user package with no admin prompt), else from fnm’s release zip into `%LOCALAPPDATA%\fnm`. It never installs Node.js through winget, because that package asks for admin rights. Then the same “Use Node.js 22 as your default Node.js?” question.
3. **npm's global folder.** If it is not writable, the script offers to move it to `%USERPROFILE%\.npm-global`.
4. **The Uncage CLI.** `npm install -g @uncage/cli`. The script runs it as `uncage.cmd`.
5. **Coding agents**, then the offer to run `uncage setup`, as on macOS.

Folders it adds to PATH go into your user `Path` (not your PowerShell profile). Open a new terminal afterwards.

### Version managers

| Version manager | Installs Node.js 22 with | After “yes” to the default |
| --- | --- | --- |
| nvm-windows | `nvm install 22` | Not done by the script: switching needs admin rights, so it prints `nvm use 22` for you to run |
| fnm | `fnm install 22` | `fnm default 22` |
| volta | `volta fetch node@22` | `volta install node@22` |

### Background service

`uncage setup` registers a scheduled task, `UncageAgent`, that starts the agent when you sign in: for your user only, with least privilege, and no admin prompt. If Task Scheduler refuses (“Access is denied”), it adds a `UncageAgent` entry under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` instead. The task runs a small supervisor that restarts the agent after a crash or a self-upgrade. Logs are in `%USERPROFILE%\.uncage\logs`. `uncage agent status` shows which one is in use.

### Uninstall

```powershell
uncage.cmd agent uninstall
uncage.cmd sites remove <id>
npm uninstall -g @uncage/cli
```

Then remove `%USERPROFILE%\.uncage` and `%USERPROFILE%\Uncage` if you want. Folders the script added to your user `Path` can be removed in **Settings → System → About → Advanced system settings → Environment Variables**.

## Another site: one click

Once `uncage setup` has installed the background agent, it also registers an `uncage://` link handler for your user (a small app on macOS, a `.desktop` file on Linux, a `HKCU` registry key on Windows; no admin rights). Any other Uncage site can then offer **Connect in one click**: the link opens a dialog on your computer that names the site’s domain and warns about look-alikes, and only after you press Connect does the usual approval start. No terminal and no second install. You can also run `uncage connect https://other.site` yourself, and `uncage dashboard` lists and disconnects every site. [Details](/docs/guides/one-click-connect/). `uncage agent uninstall` removes the handler. Run `uncage agent uninstall` before `npm uninstall -g @uncage/cli`: it removes the handler, and removing the CLI first leaves a dead one behind.

## Flags

Pass flags after `bash -s --` on macOS and Linux:

```sh
curl -fsSL https://your.site/api/uncage/install.sh | bash -s -- --yes
```

On Windows, run the script as a script block to pass parameters:

```powershell
& ([scriptblock]::Create((irm https://your.site/api/uncage/install.ps1))) -Yes
```

| install.sh | install.ps1 | Environment | |
| --- | --- | --- | --- |
| `--yes`, `-y` | `-Yes` | `UNCAGE_YES=1` | Answer yes to every install step. The default Node.js still changes only when there was no Node.js at all. |
| `--no-setup` | `-NoSetup` | `UNCAGE_NO_SETUP=1` | Install only; do not offer `uncage setup`. |
| `--lang en\|zh\|ja` | `-Lang en\|zh\|ja` | `UNCAGE_LANG` | The language of the messages. By default, your system language. |

The environment variables are the way to pass options through `irm … | iex`, which cannot take parameters.

## Non-interactive and CI

Without a terminal to ask (a CI job, `ssh host 'curl … | bash'`), the script changes nothing unless you pass `--yes` (`-Yes`). It lists what is missing with the commands to run by hand and exits with code 2.

| Exit code | Meaning |
| --- | --- |
| `0` | Done (also when you declined setup) |
| `1` | A step failed; the reason and the command to run by hand are printed |
| `2` | A confirmation was needed but there was no terminal; nothing was changed |
| `3` | Unsupported operating system or processor |

## Manual install

If you already have Node.js 22 or newer and npm, install the CLI yourself and run the setup command the website shows:

```sh
npm i -g @uncage/cli
uncage setup https://your.site
```

On Windows, use `uncage.cmd setup https://your.site` if PowerShell refuses to run `uncage` (see [Troubleshooting](/docs/reference/troubleshooting/#windows-running-scripts-is-disabled-on-this-system)).
