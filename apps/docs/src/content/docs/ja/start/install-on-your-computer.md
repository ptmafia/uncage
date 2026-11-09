---
title: コンピュータへのインストール
description: コンピュータを接続するためにウェブサイトが表示するコマンド1つが、macOS、Linux、Windowsでそれぞれ何をするか。確認してインストールするもの、使うNode.jsのバージョンマネージャー、バックグラウンドサービス、フラグ、非対話での実行、手動インストール、アンインストール。
---

Uncageで作られたウェブサイトは、コンピュータを接続するためのコマンドを1つ表示します。このコマンドはまずコンピュータを確認し、何かをインストールする前に毎回`[Y/n]`で尋ねます。インストールするのはNode.js 22（バージョンマネージャーがあればそれを使います）と、Uncage CLIです。見つかったコーディングエージェントを一覧表示し、最後にそのウェブサイト向けの`uncage setup`の実行を提案します。`uncage setup`はブラウザを開き、そこでコンピュータを承認します。`sudo`も管理者権限も使わず、同意しない限り既定のNode.jsは変更しません。

以下の例では`https://your.site`を使っています。実際には、ウェブサイトに表示されたコマンド（そのサイト自身のアドレス入り）をコピーしてください。

## macOS

```sh
curl -fsSL https://your.site/api/uncage/install.sh | bash
```

ターミナルで実行します。スクリプトはパイプで渡されますが、回答はキーボードから入力できます。

### 確認してインストールするもの

1. **コンピュータ**：Appleシリコン搭載またはIntel搭載のmacOS。それ以外は終了コード3で終了します。
2. **Node.js 22以降**：`node`が古いか見つからない場合、最初に見つかったバージョンマネージャーでNode.js 22をインストールします（下の表を参照）。バージョンマネージャーがなければHomebrew（`brew install node@22`。keg-onlyなので、今の`node`を置き換えません）を使い、Homebrewもなければfnmを`~/.local/share/fnm`にインストールします。その後、別の質問「Node.js 22を既定のNode.jsにしますか？」が表示されます。**n**と答えると既定はそのままで、スクリプトはNode.js 22をフルパスで使います。
3. **npmのグローバルフォルダ**：`sudo`なしで書き込めない場合は、`~/.npm-global`への変更を提案します（nvmのNodeはこれを許さないため、その場合は提案しません）。
4. **Uncage CLI**：ウェブサイトが指定するバージョン範囲で`npm install -g @uncage/cli`を実行します。
5. **コーディングエージェント**：インストール済みのClaude Code、Codex、ACPエージェント。1つもなければClaude Codeのインストール方法を表示して終了します。インストールしてから、もう一度コマンドを実行してください。
6. **接続**：`uncage setup https://your.site`の実行を提案します。

PATHの変更は、シェルの設定ファイル内の印付きブロック（`# >>> uncage >>>` … `# <<< uncage <<<`）1つにまとめて書き込みます。zshは`~/.zshrc`、bashは`~/.bash_profile`、それ以外は`~/.profile`です。fishの場合は追加すべき行を表示するだけです。終わったら新しいターミナルを開いてください。

### バージョンマネージャー

次の順で、最初に見つかったものを使います。インストールしたNode.js 22は既定になりません。既定が変わるのは、別の質問に「はい」と答えたときだけです。

| バージョンマネージャー | Node.js 22のインストール | 既定にすることに同意した後 |
| --- | --- | --- |
| nvm | `nvm install 22` | `nvm alias default 22` |
| fnm | `fnm install 22` | `fnm default 22` |
| mise | `mise install node@22` | `mise use -g node@22` |
| asdf | `asdf install nodejs latest:22`（`nodejs`プラグインがなければ追加します） | `asdf set -u nodejs <version>`（0.16より前のasdfでは`asdf global`） |
| volta | `volta fetch node@22` | `volta install node@22` |
| n | `n download 22` | `n 22` |

voltaはアップストリームでメンテナンスが終了しています。既存のvoltaは使いますが、スクリプトがvoltaをインストールすることはありません。nvmとfnmは最初にインストールしたバージョンを自動的に既定にします。**n**と答えた場合、スクリプトはそれを元に戻します。

### バックグラウンドサービス

`uncage setup`は、エージェントをlaunchdのユーザーエージェント（`~/Library/LaunchAgents/dev.uncage.agent.plist`）としてインストールします。ログイン時に起動し、クラッシュや自己アップグレードの後に再起動されます。インストール時のNode.jsに固定されて動きます。`uncage agent status`で確認できます。

Homebrewでのアップグレード（`brew upgrade node`または`node@22`）や、nvm / fnmのバージョンの削除では、そのNode.jsが消えます。その場合は`uncage doctor`が知らせるので、`uncage agent install`をもう一度実行してください。

### アンインストール

```sh
uncage agent uninstall
uncage sites remove <id>
npm uninstall -g @uncage/cli
```

idは`uncage sites`で一覧表示できます。データとセッションのフォルダが不要なら`~/.uncage`と`~/Uncage`を削除し、シェルの設定ファイルから`# >>> uncage >>>`ブロックを消してください。Node.jsは残ります。必要ならバージョンマネージャーで削除してください。

## Linux

```sh
curl -fsSL https://your.site/api/uncage/install.sh | bash
```

### 確認してインストールするもの

手順はmacOSと同じで、x64とarm64に対応します。バージョンマネージャーがない場合はfnmを`~/.local/share/fnm`にインストールします。fnmのインストーラーには`curl`と`unzip`が必要で、`unzip`がなければスクリプトは実行すべきコマンドを表示して終了します（パッケージマネージャーを呼び出すことはありません）。PATHのブロックは、zshなら`~/.zshrc`、bashなら`~/.bashrc`、それ以外は`~/.profile`に書き込みます。

### バージョンマネージャー

順序とコマンドはmacOSと同じです（nvm、fnm、mise、asdf、volta、n）。Homebrewによる代替はなく、バージョンマネージャーがなければfnmをホームフォルダにインストールします。

| バージョンマネージャー | Node.js 22のインストール | 既定にすることに同意した後 |
| --- | --- | --- |
| nvm | `nvm install 22` | `nvm alias default 22` |
| fnm | `fnm install 22` | `fnm default 22` |
| mise | `mise install node@22` | `mise use -g node@22` |
| asdf | `asdf install nodejs latest:22` | `asdf set -u nodejs <version>` |
| volta | `volta fetch node@22` | `volta install node@22` |
| n | `n download 22` | `n 22` |

### バックグラウンドサービス

`uncage setup`は、systemdのユーザーサービス`~/.config/systemd/user/uncage-agent.service`（`Restart=on-failure`）をインストールします。インストール時のNode.jsに固定されます。`uncage agent status`で確認できます。

linger（常駐）が有効でない限り、ユーザーサービスはログアウト時に停止します。`uncage doctor`がこれを知らせます。次のコマンドで、エージェントが動き続けるようになります。

```sh
loginctl enable-linger $USER
```

ユーザー単位のsystemdがない環境（一部のコンテナやWSL）ではサービスをインストールしません。`uncage agent`をフォアグラウンドで実行してください（たとえば`tmux`の中で）。

### アンインストール

```sh
uncage agent uninstall
uncage sites remove <id>
npm uninstall -g @uncage/cli
```

必要なら、`~/.uncage`、`~/Uncage`、シェルの設定ファイルの`# >>> uncage >>>`ブロックも削除してください。

## Windows

```powershell
irm https://your.site/api/uncage/install.ps1 | iex
```

PowerShell（Windows PowerShell 5.1またはPowerShell 7）で、通常のユーザーとして実行します。

### 確認してインストールするもの

1. **コンピュータ**：x64またはarm64のWindows。
2. **Node.js 22以降**：nvm-windows、fnm、voltaのいずれかがあればそれを使います。どれもなければ、現在のユーザー向けにfnmをインストールします。winget（`winget install --id Schniz.fnm`。ユーザー単位のパッケージで、管理者の確認は出ません）を使い、wingetがなければfnmのリリースzipを`%LOCALAPPDATA%\fnm`に展開します。wingetのNode.jsパッケージは管理者権限を求めるため、wingetでNode.jsをインストールすることはありません。その後、同じく既定にするかどうかを尋ねます。
3. **npmのグローバルフォルダ**：書き込めない場合は、`%USERPROFILE%\.npm-global`への変更を提案します。
4. **Uncage CLI**：`npm install -g @uncage/cli`。スクリプトはCLIを`uncage.cmd`として実行します。
5. **コーディングエージェント**の確認と`uncage setup`の提案は、macOSと同じです。

PATHに追加するフォルダは、ユーザーの`Path`に書き込みます（PowerShellのプロファイルではありません）。終わったら新しいターミナルを開いてください。

### バージョンマネージャー

| バージョンマネージャー | Node.js 22のインストール | 既定にすることに同意した後 |
| --- | --- | --- |
| nvm-windows | `nvm install 22` | スクリプトでは行いません。切り替えには管理者権限が必要なため、自分で実行する`nvm use 22`を表示します |
| fnm | `fnm install 22` | `fnm default 22` |
| volta | `volta fetch node@22` | `volta install node@22` |

### バックグラウンドサービス

`uncage setup`は、サインイン時にエージェントを起動するタスク スケジューラのタスク`UncageAgent`を登録します。現在のユーザーだけが対象で、最小権限で動き、管理者の確認は出ません。タスク スケジューラが拒否した場合（「Access is denied」）は、代わりに`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`に`UncageAgent`を追加します。タスクは小さな監視プロセスを実行し、クラッシュや自己アップグレードの後にエージェントを再起動します。ログは`%USERPROFILE%\.uncage\logs`にあります。どちらが使われているかは`uncage agent status`で確認できます。

### アンインストール

```powershell
uncage.cmd agent uninstall
uncage.cmd sites remove <id>
npm uninstall -g @uncage/cli
```

必要なら`%USERPROFILE%\.uncage`と`%USERPROFILE%\Uncage`も削除してください。スクリプトがユーザーの`Path`に追加したフォルダは、**設定 → システム → バージョン情報 → システムの詳細設定 → 環境変数**で削除できます。

## フラグ

macOSとLinuxでは、フラグを`bash -s --`の後に付けます。

```sh
curl -fsSL https://your.site/api/uncage/install.sh | bash -s -- --yes
```

Windowsでパラメーターを渡すには、スクリプトをスクリプトブロックとして実行します。

```powershell
& ([scriptblock]::Create((irm https://your.site/api/uncage/install.ps1))) -Yes
```

| install.sh | install.ps1 | 環境変数 | |
| --- | --- | --- | --- |
| `--yes`、`-y` | `-Yes` | `UNCAGE_YES=1` | すべてのインストール手順に「はい」と答えます。既定のNode.jsが変わるのは、もともとNode.jsがまったくなかった場合だけです。 |
| `--no-setup` | `-NoSetup` | `UNCAGE_NO_SETUP=1` | インストールだけを行い、`uncage setup`を提案しません。 |
| `--lang en\|zh\|ja` | `-Lang en\|zh\|ja` | `UNCAGE_LANG` | メッセージの言語。既定はシステムの言語です。 |

`irm … | iex`はパラメーターを受け取れないため、その場合は環境変数でオプションを渡します。

## 非対話での実行とCI

質問できるターミナルがない場合（CIのジョブ、`ssh host 'curl … | bash'`など）、`--yes`（`-Yes`）を付けない限りスクリプトは何も変更しません。足りないものと手動で実行するコマンドを表示し、終了コード2で終了します。

| 終了コード | 意味 |
| --- | --- |
| `0` | 完了（setupを断った場合も含む） |
| `1` | 手順が失敗しました。理由と手動で実行するコマンドを表示します |
| `2` | 確認が必要でしたが、ターミナルがありませんでした。何も変更していません |
| `3` | 対応していないOSまたはプロセッサー |

## 手動インストール

Node.js 22以降とnpmがすでにあるなら、CLIを自分でインストールして、ウェブサイトに表示されたsetupコマンドを実行できます。

```sh
npm i -g @uncage/cli
uncage setup https://your.site
```

Windowsで、PowerShellが`uncage`の実行を拒否する場合は`uncage.cmd setup https://your.site`を使ってください（[トラブルシューティング](/docs/ja/reference/troubleshooting/#windowsこのシステムではスクリプトの実行が無効になっている)を参照）。
