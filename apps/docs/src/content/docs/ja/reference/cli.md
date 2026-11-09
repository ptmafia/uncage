---
title: CLIリファレンス
description: Connected モード（setup、agent install / uninstall / status、sites、runtimes、activity）とLocal モード（serve、doctor）のすべてのuncageコマンドとフラグ、uncage --version、1行で実行できるインストーラー、およびそれらが読み取る環境変数。
---

`@uncage/cli`をインストールすると`uncage`コマンドが使えるようになります。エンドユーザーはサイトの1行で実行できるインストーラーか、`npm i -g @uncage/cli`で入手し、Local モードのアプリは`npx uncage …`で使います。どのコマンドにも`--help`があります。

```sh
curl -fsSL https://your.site/api/uncage/install.sh | bash        # macOS, Linux
irm https://your.site/api/uncage/install.ps1 | iex               # Windows PowerShell
```

インストーラーはコンピュータの状態（Node.js 22以降、npm、インストール済みのコーディングエージェント）を確認し、各手順の前に`[Y/n]`で確認を求め（Node.jsは、ユーザーのバージョンマネージャーがあればそれを使ってインストールします。`sudo`や管理者権限は一切使いません）、`@uncage/cli`をインストールして、そのウェブサイト向けに`uncage setup`を実行するかどうかを尋ねます。フラグ、終了コード、OSごとの詳細は[コンピュータへのインストール](/docs/ja/start/install-on-your-computer/)を参照してください。

### `uncage --version`

```text
uncage --version
0.3.0
node v22.18.0 (/Users/ada/.local/share/fnm/node-versions/v22.18.0/installation/bin/node)
```

1行目はCLIのバージョン、2行目はCLIを実行しているNode.jsとそのパスです（`uncage agent install`がバックグラウンドのエージェントを固定するのは、このNode.jsです）。

## Connected モード（ユーザーのコンピュータ上）

### `uncage setup <url>`

```text
uncage setup <url> [--no-daemon] [--no-browser]
```

このコンピュータをウェブサイトに接続します。`<url>`はサイトが表示するもので、サイトのオリジン（例：`https://app.example.com`）です。パスのないURLには`/api/uncage`が追加されます（別のベースパスにあるハブは完全なURLを表示し、それがそのまま使われます）。スキームのないURLには`https://`が付きます。

1. デバイスコードを要求し、リンクとコードを表示します。
2. ブラウザでリンクを開きます（`open`）。サインイン中のユーザーがそこで承認します。
3. 承認を待ち、サイトとマシントークンを`~/.uncage/agent.yaml`（モード0600）に保存します。
4. `uncage agent install`と同様に、このユーザーのバックグラウンドのエージェントをインストールし、起動（または再起動）します。macOSではlaunchd（`~/Library/LaunchAgents/dev.uncage.agent.plist`）、Linuxではsystemdのユーザーサービス、Windowsではタスク スケジューラのタスクを使います。サービスマネージャーがない環境では、`uncage agent`をフォアグラウンドで実行する方法を表示します。

| フラグ | |
| --- | --- |
| `--no-daemon` | バックグラウンドのエージェントをインストール・起動しません。`uncage agent`を自分で実行してください。 |
| `--no-browser` | ブラウザを開かず、リンクとコードを表示するだけにします（ブラウザのないコンピュータ向け。リンクは別のデバイスで開きます）。 |

平文の`http://`を受け付けるのは、`localhost`、`127.0.0.1`、`[::1]`の場合だけです。

### `uncage agent`

```text
uncage agent [--log-file <path>]   # run in the foreground
uncage agent install               # install and start the background agent for this user
uncage agent uninstall             # stop and remove the background agent; config and data stay
uncage agent status [--json]       # installed? running? which Node.js?
```

`uncage agent`は、`~/.uncage/agent.yaml`にあるすべてのウェブサイトに、それぞれが提供するWebSocketまたはHTTPストリーミングで接続し、それらに応答します。ウェブサイトが1つもなければ正常終了します。手動で実行したい場合は、先にバックグラウンドサービスを停止してください。

| フラグ / サブコマンド | |
| --- | --- |
| `--log-file <path>` | ログをstderrではなくこのファイルに追記します。ログファイルのサイズは起動のたびに上限内に抑えられます。 |
| `install` | ユーザー単位のバックグラウンドサービスをインストールして起動します。サービスは**このコマンドを実行しているNode.jsに固定されます**（バージョンマネージャーのシムではなく、実際のパス）。macOSではlaunchd、Linuxではsystemdのユーザーサービス、Windowsではタスク スケジューラのタスク（現在のユーザー、最小権限。タスクを作成できない場合はレジストリのRunエントリ）を使います。管理者権限は不要です。そのNode.jsを変更または削除した後は、もう一度実行してください。`UNCAGE_HOME`が設定されている間は拒否されます。 |
| `uninstall` | サービスを停止して削除します。`~/.uncage/agent.yaml`とデータは残ります。 |
| `status` | サービスの種類、インストール済みか、実行中か、定義ファイル、固定されたNode.js（とそれがまだ存在するか）、CLIのエントリ、ログのフォルダ（`~/.uncage/logs`）を表示します。`--json`を付けると同じ内容をJSONで出力します。 |
| `--supervise` | 内部用：Windowsのタスク スケジューラのタスクは`uncage agent --supervise`を実行し、クラッシュや自己アップグレードの後にエージェントを再起動します（タスク スケジューラはこれを行わないためです）。macOSとLinuxでは不要です。 |

Linuxでは、linger（常駐）が有効でない限り、ユーザーサービスはログアウト時に停止します。`uncage doctor`がこれを知らせ、`loginctl enable-linger $USER`で解決できます。LinuxとWindowsはCIで検証済みで、実機での確認を待っている段階です。macOSは実機で検証済みです。

### `uncage sites`

```text
uncage sites                 # ID, NAME, HOST, MACHINE, STATUS
uncage sites remove <id>     # disconnect a website
```

`remove`は、ウェブサイト上でこのコンピュータを取り消し（自身のトークンで`POST <hub>/machine/revoke`）、`agent.yaml`からトークンを削除して、バックグラウンドのエージェントを再起動します。ローカルのセッションデータ（`~/.uncage/sites/<id>`）とワークスペース（`~/Uncage/…`）は残ります。

### `uncage runtimes`

```text
uncage runtimes [--json] [--all] [--refresh]   # ID, NAME, STATUS, VERSION, SITE TOOLS, RESUME
uncage runtimes enable <id>                    # register an ACP registry agent (consent for npx/uvx)
uncage runtimes disable <id>                   # never register an ACP agent
```

`uncage agent`がウェブサイトに提供するランタイムを一覧表示します。Claude Code、Codex、そして`~/.uncage/agent.yaml`の`runtimes.acp`によるACPエージェント（プリセット、自分で書いたエントリ、ACPレジストリから検出したエージェント）について、状態と、サイトツールや再開に対応しているかを表示します。続いて、登録されていないACPレジストリのエージェントとその理由を表示します。

| フラグ | |
| --- | --- |
| `--json` | `{ runtimes, registry }`をJSONで出力 |
| `--all` | このコンピュータにインストールされていないレジストリのエージェントも表示 |
| `--refresh` | 先に最新のACPレジストリをダウンロード（指定しなければキャッシュか同梱のコピー） |

`enable`は実行される内容をそのまま表示し、同意を`runtimes.acp.enable` / `consented`に記録します。`npx`や`uvx`で配布されるエージェントは、これがなければ決して実行されません。`disable`はIDを`runtimes.acp.disable`に追加します。どちらもバックグラウンドのエージェントを再起動します。詳しくは[あらゆるACPエージェントを使う](/docs/ja/guides/use-any-acp-agent/)を参照してください。

### `uncage activity`

```text
uncage activity [--site <id>] [--follow] [--json]
```

接続中のウェブサイトがこのコンピュータに何をさせたかを表示します。すべてのコマンド、サイトツールの呼び出し、ファイルの取得、承認に加え、接続・切断・取り消し・アップグレードも含まれます。内容は秘匿化されており、ID、状態、エラーコードは残りますが、プロンプト、ファイルの内容、ツールの引数は残りません。

| フラグ | |
| --- | --- |
| `--site <id>` | このウェブサイトだけ（`uncage sites`を参照） |
| `--follow`、`-f` | 新しいエントリーを表示し続けます |
| `--json` | 1行に1つのJSONオブジェクト |

## Local モード（アプリを動かすマシン上）

### `uncage serve`

```text
uncage serve [--port <n>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
```

ローカルのデーモンを`127.0.0.1`（ループバックのみ）で起動します。

| フラグ | デフォルト |
| --- | --- |
| `--port <n>` | `4783`、または`UNCAGE_PORT` |
| `--workspace <dir>` | カレントディレクトリ。エージェントが読み書きするフォルダです。 |
| `--data-dir <dir>` | `~/.uncage/data`（セッションとイベント） |
| `--token-file <file>` | `~/.uncage/token`（Bearerトークン。モード600で作成されます） |

作業ディレクトリには任意で`uncage.config.yaml`を置けます。[Local モードの詳細](/docs/ja/reference/local-mode/#設定)を参照してください。

### `uncage doctor`

```text
uncage doctor [--port <n> | --url <url>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
uncage doctor --export-events <sessionId> [--out <file>] [--include-content] [--port <n> | --url <url>]
```

Node、データディレクトリ、トークン、実行中のデーモン、Connected モードのバックグラウンドのエージェント（インストール済みで実行中か、固定されたNode.jsがまだ存在するか、Linuxのlinger（常駐）、接続中の各ウェブサイトのエージェントのバージョン）、ランタイム（Claude Code、Codex、そしてACPエージェントごとに1行の`runtime.acp-<id>`。`uncage.config.yaml`の`runtimes.acp`で設定したものか、自動検出したもの）をチェックします。各行は ✓ か ✗ で、✗ の行には必ず`fix:`コマンドが表示されます。ACPの行は任意扱いで、✗（たとえば未インストールで、fixはインストールのヒント）でも終了コードは変わりません。`uncage.config.yaml`が独自の`command`で追加したACPエージェントには、実行するコマンドを示す警告行も表示されます。デーモンのワークスペースが`.uncage/`を無視していないgitリポジトリである場合と、ループバック以外のURLにトークンを送る前には、警告（`!`、致命的ではない）を出します。

`--export-events`は、バグ報告用にセッションのイベントをJSONで書き出します。`--include-content`を付けない限り、内容は秘匿化されます。

デーモンは`--url`、`--port`、`UNCAGE_URL`、`UNCAGE_PORT`、`uncage.config.yaml`、`4783`の順で探されます。

## 環境変数

| 変数 | 使用するもの | |
| --- | --- | --- |
| `UNCAGE_HOME` | Connected モードのコマンド | `~/.uncage`と`~/Uncage`の`~`を置き換える絶対パス（開発・テスト用）。`--no-daemon`を付けない限り、`uncage setup`はこれを拒否します。`HOME`は変わらないため、Claude Codeのログイン状態は保たれます。 |
| `UNCAGE_LOG_LEVEL` | `serve`、`agent` | ログレベル。例：`debug` |
| `UNCAGE_ACP_REGISTRY_REFRESH=0` | `agent` | ACPレジストリを毎日ダウンロードしない（キャッシュか同梱のコピーを使用） |
| `UNCAGE_PORT` | `serve`、`doctor` | デーモンのポート |
| `UNCAGE_URL` | `doctor`、Local モードのプロキシ | デーモンのURL（デフォルトは`http://127.0.0.1:4783`） |
| `UNCAGE_ALLOW_BYPASS=1` | `serve` | Local モードで`bypassPermissions`を提供します（警告を表示します） |
| `UNCAGE_TOKEN` | Local モードのプロキシ | `~/.uncage/token`にない場合のデーモンのトークン |
| `UNCAGE_ALLOWED_HOSTS` | Local モードのプロキシ | 許可する`Host`名（カンマ区切り） |
| `UNCAGE_YES=1` | `install.sh`、`install.ps1` | すべてのインストール手順に「はい」と答えます（`--yes` / `-Yes`） |
| `UNCAGE_NO_SETUP=1` | `install.sh`、`install.ps1` | インストールだけを行い、`uncage setup`を提案しません（`--no-setup` / `-NoSetup`） |
| `UNCAGE_LANG` | `install.sh`、`install.ps1` | インストーラーのメッセージの言語：`en`、`zh`、`ja`（`--lang` / `-Lang`） |

Connected モードでは、バイパスを制御できるのは`~/.uncage/agent.yaml`の`localPolicy.allowBypass`だけです（[ローカルポリシー](/docs/ja/guides/local-policy/)）。
