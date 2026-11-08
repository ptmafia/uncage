---
title: 在你的电脑上安装
description: 网站为连接你的电脑而给出的那一条命令，在 macOS、Linux 和 Windows 上分别做什么：检查和安装哪些东西、使用哪些 Node.js 版本管理器、后台服务、参数、非交互运行、手动安装和卸载。
---

用 Uncage 搭建的网站会给出一条命令，用来连接你的电脑。这条命令会先检查电脑，每安装一样东西之前都会问 `[Y/n]`：先是 Node.js 22（有版本管理器时就用你自己的版本管理器），然后是 Uncage CLI。它会列出找到的 coding agent，最后提议为这个网站运行 `uncage setup`：它会打开浏览器，让你批准这台电脑。整个过程不使用 `sudo`，也不需要管理员权限；除非你同意，它不会改动你的默认 Node.js。

下面的示例使用 `https://your.site`；请复制网站上显示的命令，那里是网站自己的地址。

## macOS

```sh
curl -fsSL https://your.site/api/uncage/install.sh | bash
```

在“终端”里运行。虽然脚本是通过管道传进来的，回答仍然来自你的键盘。

### 检查和安装什么

1. **电脑。** Apple 芯片或 Intel 的 macOS。其他情况会以退出码 3 停止。
2. **Node.js 22 或更新版本。** 如果 `node` 版本过旧或不存在，它会用找到的第一个版本管理器安装 Node.js 22（见下表）。没有版本管理器时，使用 Homebrew（`brew install node@22`，它是 keg-only 的，不会替换你的 `node`）；连 Homebrew 也没有时，把 fnm 安装到 `~/.local/share/fnm`。之后还有一个单独的问题：“把 Node.js 22 设为你的默认 Node.js？”回答 **n** 时，你的默认版本保持不变，脚本通过完整路径使用 Node.js 22。
3. **npm 的全局目录。** 如果不用 `sudo` 就无法写入，脚本会提议把它改到 `~/.npm-global`（nvm 的 Node 不允许这样做，所以不会提议）。
4. **Uncage CLI。** 按网站要求的版本范围运行 `npm install -g @uncage/cli`。
5. **coding agent。** 已安装的 Claude Code、Codex 和 ACP agent。一个都没有时，它会打印 Claude Code 的安装方法并停止；装好后再运行一次这条命令。
6. **连接。** 提议运行 `uncage setup https://your.site`。

对 PATH 的修改写在 shell 配置文件中一个带标记的块里（`# >>> uncage >>>` … `# <<< uncage <<<`）：zsh 写入 `~/.zshrc`，bash 写入 `~/.bash_profile`，其他情况写入 `~/.profile`。fish 只打印需要添加的那一行。完成后请打开一个新终端。

### 版本管理器

按以下顺序使用找到的第一个。安装的 Node.js 22 不会成为默认版本；只有在另一个问题上回答“是”之后，默认版本才会改变。

| 版本管理器 | 安装 Node.js 22 的命令 | 同意设为默认后 |
| --- | --- | --- |
| nvm | `nvm install 22` | `nvm alias default 22` |
| fnm | `fnm install 22` | `fnm default 22` |
| mise | `mise install node@22` | `mise use -g node@22` |
| asdf | `asdf install nodejs latest:22`（缺少 `nodejs` 插件时会先添加） | `asdf set -u nodejs <version>`（0.16 之前的 asdf 用 `asdf global`） |
| volta | `volta fetch node@22` | `volta install node@22` |
| n | `n download 22` | `n 22` |

volta 上游已经停止维护：已有的 volta 会被使用，但脚本从不安装它。nvm 和 fnm 会自动把它们安装的第一个版本设为默认；你回答 **n** 时，脚本会撤销这一步。

### 后台服务

`uncage setup` 把守护进程安装为 launchd 用户代理（`~/Library/LaunchAgents/dev.uncage.agent.plist`）。它在登录时启动，崩溃或自我升级后会被重启，并且固定使用安装时的那个 Node.js。`uncage agent status` 可以查看它。

Homebrew 升级（`brew upgrade node` 或 `node@22`）或删除 nvm / fnm 的某个版本，都会删掉那个 Node.js。这时 `uncage doctor` 会提示；重新运行 `uncage agent install` 即可。

### 卸载

```sh
uncage agent uninstall
uncage sites remove <id>
npm uninstall -g @uncage/cli
```

`uncage sites` 会列出 id。如果不再需要数据和会话目录，再删除 `~/.uncage` 和 `~/Uncage`，并从 shell 配置文件中删掉 `# >>> uncage >>>` 块。Node.js 会保留；需要的话用你的版本管理器删除。

## Linux

```sh
curl -fsSL https://your.site/api/uncage/install.sh | bash
```

### 检查和安装什么

步骤与 macOS 相同，支持 x64 和 arm64。没有版本管理器时，它把 fnm 安装到 `~/.local/share/fnm`；fnm 的安装脚本需要 `curl` 和 `unzip`，缺少 `unzip` 时脚本会停止并给出需要运行的命令（它从不调用你的包管理器）。PATH 块写入位置：zsh 为 `~/.zshrc`，bash 为 `~/.bashrc`，其他情况为 `~/.profile`。

### 版本管理器

顺序和命令与 macOS 相同：nvm、fnm、mise、asdf、volta、n。没有 Homebrew 这一备选；没有版本管理器时，fnm 会被安装到你的主目录下。

| 版本管理器 | 安装 Node.js 22 的命令 | 同意设为默认后 |
| --- | --- | --- |
| nvm | `nvm install 22` | `nvm alias default 22` |
| fnm | `fnm install 22` | `fnm default 22` |
| mise | `mise install node@22` | `mise use -g node@22` |
| asdf | `asdf install nodejs latest:22` | `asdf set -u nodejs <version>` |
| volta | `volta fetch node@22` | `volta install node@22` |
| n | `n download 22` | `n 22` |

### 后台服务

`uncage setup` 安装一个 systemd 用户服务 `~/.config/systemd/user/uncage-agent.service`（`Restart=on-failure`），固定使用安装时的 Node.js。`uncage agent status` 可以查看它。

除非开启了驻留（linger），用户服务会在你注销时停止。`uncage doctor` 会提示你；运行下面的命令可让守护进程保持运行：

```sh
loginctl enable-linger $USER
```

没有用户级 systemd 时（部分容器和 WSL 环境），不会安装服务：请在前台运行 `uncage agent`，例如放在 `tmux` 里。

### 卸载

```sh
uncage agent uninstall
uncage sites remove <id>
npm uninstall -g @uncage/cli
```

需要的话，再删除 `~/.uncage`、`~/Uncage`，以及 shell 配置文件中的 `# >>> uncage >>>` 块。

## Windows

```powershell
irm https://your.site/api/uncage/install.ps1 | iex
```

以普通用户身份在 PowerShell（Windows PowerShell 5.1 或 PowerShell 7）中运行。

### 检查和安装什么

1. **电脑。** x64 或 arm64 的 Windows。
2. **Node.js 22 或更新版本**，已安装 nvm-windows、fnm 或 volta 时使用它们。都没有时，为当前用户安装 fnm：优先用 winget（`winget install --id Schniz.fnm`，按用户安装的包，不弹出管理员提示），否则从 fnm 的发布 zip 解压到 `%LOCALAPPDATA%\fnm`。它从不通过 winget 安装 Node.js，因为那个包需要管理员权限。之后同样会问是否把 Node.js 22 设为默认。
3. **Uncage CLI。** `npm install -g @uncage/cli`。脚本以 `uncage.cmd` 的方式运行它。
4. **coding agent**，然后提议运行 `uncage setup`，与 macOS 相同。

需要加入 PATH 的目录写入你的用户 `Path`（而不是 PowerShell 配置文件）。完成后请打开一个新终端。

### 版本管理器

| 版本管理器 | 安装 Node.js 22 的命令 | 同意设为默认后 |
| --- | --- | --- |
| nvm-windows | `nvm install 22` | 脚本不做：切换需要管理员权限，所以它会打印 `nvm use 22`，由你自己运行 |
| fnm | `fnm install 22` | `fnm default 22` |
| volta | `volta fetch node@22` | `volta install node@22` |

### 后台服务

`uncage setup` 注册一个计划任务 `UncageAgent`，在你登录时启动守护进程：只针对当前用户、最低权限、不弹出管理员提示。如果任务计划程序拒绝（“Access is denied”），则改为在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下添加一个 `UncageAgent` 项。计划任务运行一个小的监督进程，在守护进程崩溃或自我升级后将其重启。日志在 `%USERPROFILE%\.uncage\logs`。`uncage agent status` 会显示实际使用的是哪一种。

### 卸载

```powershell
uncage.cmd agent uninstall
uncage.cmd sites remove <id>
npm uninstall -g @uncage/cli
```

需要的话，再删除 `%USERPROFILE%\.uncage` 和 `%USERPROFILE%\Uncage`。脚本加入用户 `Path` 的目录，可以在 **设置 → 系统 → 系统信息 → 高级系统设置 → 环境变量** 中删除。

## 参数

在 macOS 和 Linux 上，把参数放在 `bash -s --` 之后：

```sh
curl -fsSL https://your.site/api/uncage/install.sh | bash -s -- --yes
```

在 Windows 上，以脚本块的方式运行脚本才能传参数：

```powershell
& ([scriptblock]::Create((irm https://your.site/api/uncage/install.ps1))) -Yes
```

| install.sh | install.ps1 | 环境变量 | |
| --- | --- | --- | --- |
| `--yes`、`-y` | `-Yes` | `UNCAGE_YES=1` | 对每个安装步骤都回答“是”。只有原本完全没有 Node.js 时，默认 Node.js 才会改变。 |
| `--no-setup` | `-NoSetup` | `UNCAGE_NO_SETUP=1` | 只安装，不提议运行 `uncage setup`。 |
| `--lang en\|zh\|ja` | `-Lang en\|zh\|ja` | `UNCAGE_LANG` | 提示信息的语言。默认跟随系统语言。 |

`irm … | iex` 无法接收参数，这时就用环境变量传递选项。

## 非交互运行与 CI

没有可以提问的终端时（CI 任务、`ssh host 'curl … | bash'`），除非传了 `--yes`（`-Yes`），脚本不会做任何改动。它会列出缺少的东西和手动运行的命令，并以退出码 2 结束。

| 退出码 | 含义 |
| --- | --- |
| `0` | 完成（你拒绝运行 setup 时也是 0） |
| `1` | 某一步失败；会打印原因和手动运行的命令 |
| `2` | 需要确认但没有终端；没有做任何改动 |
| `3` | 不支持的操作系统或处理器 |

## 手动安装

如果你已经有 Node.js 22 或更新版本以及 npm，可以自己安装 CLI，然后运行网站显示的 setup 命令：

```sh
npm i -g @uncage/cli
uncage setup https://your.site
```

在 Windows 上，如果 PowerShell 拒绝运行 `uncage`，请改用 `uncage.cmd setup https://your.site`（见[故障排查](/docs/zh-cn/reference/troubleshooting/#windows在此系统上禁止运行脚本)）。
