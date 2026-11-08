---
title: ローカルポリシーとユーザーのコンピュータ
description: 'エンドユーザーが自分のコンピュータで管理するもの：~/.uncage/agent.yamlとlocalPolicy（allowBypass、allowedPermissionModes）、アクティビティログ、フォルダ、バックグラウンドのエージェント、ウェブサイトの切断、ローカル拡張。'
---

このページでは**ユーザー側**、つまり`uncage agent`を動かすコンピュータについて説明します。サイトが要求できることの上限はここで決まるため、ウェブサイトの開発者も知っておくべき内容です。その理由は[トラストモデル](/docs/ja/concepts/trust-model/)で説明しています。

## ファイルとフォルダ

| パス | 内容 |
| --- | --- |
| `~/.uncage/agent.yaml` | 接続済みのウェブサイト（マシントークンを含む）と`localPolicy`。モードは0600で、それより緩いパーミッションはエージェントが厳しく直します。 |
| `~/.uncage/sites/<site id>/data` | そのウェブサイトのセッションを保存するローカルデータベース（正となるデータ） |
| `~/.uncage/sites/<site id>/activity.log` | そのウェブサイトがこのコンピュータで行ったこと（JSON Lines） |
| `~/Uncage/<site host>/<session id>/` | セッションごとのフォルダ。Claude Codeはここで作業します |
| `~/.uncage/logs/agent.log`、`agent.err.log` | バックグラウンドのエージェントの出力 |
| `~/Library/LaunchAgents/dev.uncage.agent.plist` | エージェントを常駐させるlaunchdサービス |

開発やテストでは、`UNCAGE_HOME=/absolute/path`で`~/.uncage`と`~/Uncage`の場所を移せます（バックグラウンドサービスでは使えません。`uncage setup <url> --no-daemon`を実行してから、同じ環境変数を付けて`uncage agent`をフォアグラウンドで起動してください）。`HOME`は変わらないため、Claude Codeのログイン状態はそのまま保たれます。

## `~/.uncage/agent.yaml`

このファイルは`uncage setup`が作成・更新します。典型的な内容は次のとおりです。

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

手で編集することを想定しているのは`localPolicy`と`runtimes`だけです。`uncage setup`や`uncage sites remove`が`sites`の一覧を書き換えても、コメント、`localPolicy`、`runtimes`は保持されます。未知のキーはエラーになり、そのキー名が表示されます。

### `localPolicy.allowBypass`

デフォルトは`false`です。`bypassPermissions`を使うと、Claude Codeは**確認なしで**任意のコマンドを実行し、任意のファイルを編集できます。ウェブサイトはUIでこのモードを提示できますが、この値が`true`でない限り、エージェントは`policy_denied`（「bypassPermissions can only be enabled on this computer (localPolicy.allowBypass in ~/.uncage/agent.yaml)」）で拒否します。ウェブサイト側のどんな設定でもこれは変えられません。

```yaml
localPolicy:
  allowBypass: true
```

有効にすると、エージェントは起動時に警告をログに出します。`requiresConfirmation`が指定されたツールは、バイパスモードでも確認を求めます。

### `localPolicy.allowedPermissionModes`

このコンピュータで**どの**ウェブサイトでも使えるモードを制限する、任意の上限設定です。それ以外のモードへの設定変更や、それ以外のモードで開始された実行は、`policy_denied`（「Permission mode "…" is not allowed on this computer (localPolicy.allowedPermissionModes)」）で拒否されます。

```yaml
localPolicy:
  allowBypass: false
  allowedPermissionModes: [default, plan]   # ask for everything, or plan only
```

モードは`default`、`acceptEdits`、`plan`、`auto`、`bypassPermissions`です（最後のものは`allowBypass: true`も必要です）。新しいセッションは`default`で始まるため、ユーザーが許可されたモードを選ぶまですべての実行を拒否したいのでなければ、一覧に`default`を残してください。

### `runtimes.acp`

このコンピュータがClaude CodeとCodex以外に提供するエージェントを設定します。Gemini CLI、OpenCode、Claude CodeのACPアダプターなど、Agent Client Protocolに対応したエージェントです。ACPレジストリのエージェントのうちコードをダウンロードするもの（`npx`、`uvx`）は、`uncage runtimes enable <id>`を実行した後にだけ動きます。提供中のものは`uncage runtimes`で一覧できます。詳しくは[あらゆるACP エージェントを使う](/docs/ja/guides/use-any-acp-agent/)を参照してください。

### 変更を反映する

エージェントは起動時に`agent.yaml`を読み込みます。編集したら再起動してください。

```sh
launchctl kickstart -k gui/$(id -u)/dev.uncage.agent    # the background service
```

フォアグラウンドで動かしている場合は、`uncage agent`を停止してから起動し直します。

## アクティビティログ

ウェブサイトが送ったすべてのコマンド、すべてのサイトツール呼び出し、すべてのファイル取得、すべての承認が、接続・切断・取り消し・アップグレードとともに`~/.uncage/sites/<site id>/activity.log`に追記されます。

```sh
uncage activity                       # every website
uncage activity --site app.example.com --follow
uncage activity --json                # one JSON object per line
```

ログは秘匿化されています。ID、状態、エラーコードは残りますが、プロンプト、ファイルの内容、ツールの引数は記録されません。

## ウェブサイト

```sh
uncage sites                          # ID, NAME, HOST, MACHINE, STATUS
uncage sites remove app.example.com   # disconnect
```

`uncage sites remove`は、このコンピュータ自身のトークンを使ってウェブサイト上でこのコンピュータを取り消し、`agent.yaml`からトークンを削除して、バックグラウンドのエージェントを再起動します。ローカルのセッションデータとワークスペースは残ります。ウェブサイトに到達できない場合でもトークンは削除され、コンピュータはウェブサイト側から取り消すこともできます。

ウェブサイトがコンピュータを取り消すと、エージェントは`agent.yaml`でそのサイトを`revoked`とマークし、以後は接続しません。もう一度接続するには`uncage setup <url>`を再実行してください（まだ接続中のウェブサイトに対して`uncage setup`を実行すると再ペアリングになります。マシンIDとセッションはそのままで、新しいトークンが発行されます）。

## バックグラウンドのエージェント

- `uncage setup <url>`はエージェントをlaunchdのユーザーエージェントとしてインストールします。ログイン時に起動し、クラッシュや自己アップグレードの後にはlaunchdが再起動します（正常終了の後、たとえば接続中のウェブサイトがなくなったときは再起動しません）。
- `uncage agent uninstall`はエージェントを停止し、サービスを削除します。`agent.yaml`とデータは残ります。
- `uncage agent`はエージェントをフォアグラウンドで実行します（先にサービスを停止してください）。詳しい出力が必要なら`UNCAGE_LOG_LEVEL=debug`を指定します。
- アップグレード：ハブがより新しいエージェントを要求した場合（`upgrade_required`）、エージェントは`npm i -g @uncage/cli@latest`を1回実行してから再起動します。
- 1つのエージェントが、接続中のすべてのウェブサイトを担当します。接続、データベース、フォルダはウェブサイトごとに分かれています。Local モード（`uncage serve`）を同じコンピュータで同時に動かすこともできます。

## ローカル拡張

実行可能な拡張（たとえば実行完了時にプロジェクトをデプロイするフック）は、必ず**このコンピュータ**から提供されるものに限られます。ユーザーがインストールしたnpmパッケージや、ユーザーが書いたローカル設定です。ウェブサイトが送れるのはデータ（ツールのスキーマ、スキルのテキスト、テンプレート）だけで、ここで実行するコードは送れません。Uncage 0.2にはまだローカル拡張のAPIがなく、現時点でのローカルの制御手段は`localPolicy`です。
