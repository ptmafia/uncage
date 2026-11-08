---
title: CLI リファレンス
description: Connected モード（setup、agent、sites、activity）と Local モード（serve、doctor）のすべての uncage コマンドとフラグ、およびそれらが読み取る環境変数。
---

`@uncage/cli` をインストールすると `uncage` コマンドが使えるようになります。エンドユーザーはサイトの `install.sh`（または `npm i -g @uncage/cli`）から入手し、Local モードのアプリは `npx uncage …` で使います。どのコマンドにも `--help` があります。

## Connected モード（ユーザーのコンピュータ上）

### `uncage setup <url>`

```text
uncage setup <url> [--no-daemon] [--no-browser]
```

このコンピュータをウェブサイトに接続します。`<url>` はサイトが表示するもので、サイトのオリジン（例：`https://app.example.com`）です。パスのない URL には `/api/uncage` が追加されます（別のベースパスにあるハブは完全な URL を表示し、それがそのまま使われます）。スキームのない URL には `https://` が付きます。

1. デバイスコードを要求し、リンクとコードを表示します。
2. ブラウザでリンクを開きます（`open`）。サインイン中のユーザーがそこで承認します。
3. 承認を待ち、サイトと machine トークンを `~/.uncage/agent.yaml`（モード 0600）に保存します。
4. バックグラウンドのエージェントをインストールし、起動（または再起動）します（launchd：`~/Library/LaunchAgents/dev.uncage.agent.plist`）。

| フラグ | |
| --- | --- |
| `--no-daemon` | バックグラウンドのエージェントをインストール・起動しません。`uncage agent` を自分で実行してください。 |
| `--no-browser` | ブラウザを開かず、リンクとコードを表示するだけにします（ブラウザのないコンピュータ向け。リンクは別のデバイスで開きます）。 |

平文の `http://` を受け付けるのは、`localhost`、`127.0.0.1`、`[::1]` の場合だけです。

### `uncage agent`

```text
uncage agent              # run in the foreground
uncage agent uninstall    # stop and remove the background agent; config and data stay
```

`~/.uncage/agent.yaml` にあるすべてのウェブサイトに接続し、それらに応答します。ウェブサイトが 1 つもなければ正常終了します。手動で実行したい場合は、先にバックグラウンドサービスを停止してください。

### `uncage sites`

```text
uncage sites                 # ID, NAME, HOST, MACHINE, STATUS
uncage sites remove <id>     # disconnect a website
```

`remove` は、ウェブサイト上でこのコンピュータを取り消し（自身のトークンで `POST <hub>/machine/revoke`）、`agent.yaml` からトークンを削除して、バックグラウンドのエージェントを再起動します。ローカルのセッションデータ（`~/.uncage/sites/<id>`）とワークスペース（`~/Uncage/…`）は残ります。

### `uncage activity`

```text
uncage activity [--site <id>] [--follow] [--json]
```

接続中のウェブサイトがこのコンピュータに何をさせたかを表示します。すべてのコマンド、サイトツールの呼び出し、ファイルの取得、承認に加え、接続・切断・取り消し・アップグレードも含まれます。内容は秘匿化されており、ID、状態、エラーコードは残りますが、プロンプト、ファイルの内容、ツールの引数は残りません。

| フラグ | |
| --- | --- |
| `--site <id>` | このウェブサイトだけ（`uncage sites` を参照） |
| `--follow`、`-f` | 新しいエントリーを表示し続けます |
| `--json` | 1 行に 1 つの JSON オブジェクト |

## Local モード（アプリを動かすマシン上）

### `uncage serve`

```text
uncage serve [--port <n>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
```

ローカルのデーモンを `127.0.0.1`（ループバックのみ）で起動します。

| フラグ | デフォルト |
| --- | --- |
| `--port <n>` | `4783`、または `UNCAGE_PORT` |
| `--workspace <dir>` | カレントディレクトリ。エージェントが読み書きするフォルダーです。 |
| `--data-dir <dir>` | `~/.uncage/data`（セッションとイベント） |
| `--token-file <file>` | `~/.uncage/token`（Bearer トークン。モード 600 で作成されます） |

作業ディレクトリには任意で `uncage.config.yaml` を置けます。[Local モードの詳細](/docs/ja/reference/local-mode/#設定)を参照してください。

### `uncage doctor`

```text
uncage doctor [--port <n> | --url <url>] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
uncage doctor --export-events <sessionId> [--out <file>] [--include-content] [--port <n> | --url <url>]
```

Node、データディレクトリ、トークン、実行中のデーモン、ランタイム（Claude Code、Codex）をチェックします。各行は ✓ か ✗ で、✗ の行には必ず `fix:` コマンドが表示されます。デーモンのワークスペースが `.uncage/` を無視していない git リポジトリである場合と、ループバック以外の URL にトークンを送る前には、警告（`!`、致命的ではない）を出します。

`--export-events` は、バグ報告用にセッションのイベントを JSON で書き出します。`--include-content` を付けない限り、内容は秘匿化されます。

デーモンは `--url`、`--port`、`UNCAGE_URL`、`UNCAGE_PORT`、`uncage.config.yaml`、`4783` の順で探されます。

## 環境変数

| 変数 | 使用するもの | |
| --- | --- | --- |
| `UNCAGE_HOME` | Connected モードのコマンド | `~/.uncage` と `~/Uncage` の `~` を置き換える絶対パス（開発・テスト用）。`--no-daemon` を付けない限り、`uncage setup` はこれを拒否します。`HOME` は変わらないため、Claude Code のログイン状態は保たれます。 |
| `UNCAGE_LOG_LEVEL` | `serve`、`agent` | ログレベル。例：`debug` |
| `UNCAGE_PORT` | `serve`、`doctor` | デーモンのポート |
| `UNCAGE_URL` | `doctor`、Local モードのプロキシ | デーモンの URL（デフォルトは `http://127.0.0.1:4783`） |
| `UNCAGE_ALLOW_BYPASS=1` | `serve` | Local モードで `bypassPermissions` を提供します（警告を表示します） |
| `UNCAGE_TOKEN` | Local モードのプロキシ | `~/.uncage/token` にない場合のデーモンのトークン |
| `UNCAGE_ALLOWED_HOSTS` | Local モードのプロキシ | 許可する `Host` 名（カンマ区切り） |

Connected モードでは、バイパスを制御できるのは `~/.uncage/agent.yaml` の `localPolicy.allowBypass` だけです（[ローカルポリシー](/docs/ja/guides/local-policy/)）。
