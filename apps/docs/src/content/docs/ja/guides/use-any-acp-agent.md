---
title: あらゆるACP エージェントを使う
description: 'Claude CodeとCodexに加えて、Gemini CLI、OpenCode、Claude CodeのACPアダプターなど、Agent Client Protocolに対応したエージェントを提供する方法：~/.uncage/agent.yamlのruntimes.acp、プリセット、ACPレジストリ、ネイティブランタイムとの違い、トラブルシューティング、チェックリスト。'
---

[Agent Client Protocol](https://agentclientprotocol.com)（ACP）は、クライアント（エディタ、ここではUncage）とコーディングエージェントの間のオープンなプロトコルです。クライアントはエージェントをローカルプロセスとして起動し、stdin/stdout経由でJSON-RPCをやり取りします。セッションを作成してプロンプトを送り、ストリーミングされるメッセージ、ツール呼び出し、計画、権限リクエストを受け取ります。Gemini CLI、OpenCode、ACPアダプター経由のClaude Code、そして[ACPレジストリ](https://github.com/agentclientprotocol/registry)にある数十のエージェントが対応しています。

`@uncage/runtime-acp`は、こうしたエージェントをそれぞれUncageのランタイムにします。各エージェントは、ネイティブのClaude CodeランタイムやCodexランタイムと並んで、ウェブサイトのランタイム選択に`<name> (ACP)`として表示されます。ランタイムIDは`acp-<id>`です。エージェントはユーザーのコンピュータ上のセッションフォルダで、エージェント自身のログインを使って動きます。Uncageがその認証情報を見ることはありません。

このページは[ローカルポリシー](/docs/ja/guides/local-policy/)と同じく**ユーザー側**（`uncage agent`を動かすコンピュータ）の話です。ウェブサイト側の変更は不要で、新しいランタイムは他のランタイムと同じくハブ経由で届きます。

## 設定

ACP エージェントは`~/.uncage/agent.yaml`の`runtimes.acp`で設定します。`runtimes`キーがまったくない場合はデフォルトが使われます。コマンドがPATH上にあるプリセットが登録され、ACPレジストリにあるインストール済みのエージェントが検出されます。すべてのフィールドを含む完全な例は次のとおりです。

```yaml
runtimes:
  acp:
    presets: auto        # auto: register the presets whose command is on PATH; off: only what is listed below
    autoDetect: true     # detect installed agents from the ACP registry (handshake-checked); false: no detection
    enable: [gemini]     # registry agents you consented to run (written by `uncage runtimes enable`)
    consented:           # exactly what each `enable` consented to run (written by `uncage runtimes enable`)
      gemini:
        runner: npx
        package: "@google/gemini-cli"
        args: [--acp]
        env: {}
    disable: [opencode]  # registry, preset or runtime ids that are never registered
    agents:
      - id: claude                    # runtime id acp-claude
        preset: claude                # fill in the preset's name, command and install hint
      - id: mine                      # runtime id acp-mine
        displayName: My Agent         # shown in the runtime picker (default: the preset's name, else the id)
        command: [/usr/local/bin/my-agent, --acp]   # argv; command[0] is an absolute path or found on PATH
        env:                          # added to the agent's environment
          MY_AGENT_LOG: warn
        mcp: auto                     # site tools: auto (http if the agent supports it, else stdio), http, stdio, off
        enabled: true                 # false keeps the entry but does not register it
```

| フィールド | デフォルト | |
| --- | --- | --- |
| `presets` | `auto` | `auto`は、コマンドがPATH上にあり、`agents`にまだ書かれていない[プリセット](#プリセット)をすべて登録します。`off`：登録しません。 |
| `autoDetect` | `true` | ACPレジストリからインストール済みのエージェントを検出します。ACPの`initialize`ハンドシェイクに応答したエージェントだけが有効になります（パスとファイルのバージョンごとにキャッシュ）。`false`：検出もハンドシェイクも行いません。 |
| `enable` | `[]` | 検出されなくても実行するレジストリのエージェント。たとえば`npx`や`uvx`でダウンロードされるエージェントです。手で編集せず、`uncage runtimes enable <id>`を使ってください。 |
| `consented` | `{}` | `enable`の各IDについて、同意した内容：実行方法（`local`、`npx`、`uvx`）、コマンドまたはパッケージ（バージョンは問わない）、`args`、`env`。同じパッケージの新しいバージョンは、改めて同意しなくても実行されます。レジストリが後で別のもの（別のパッケージや実行方法、異なる`args`や`env`）を実行するようになると、そのエージェントは再度の`uncage runtimes enable`を待ちます。 |
| `disable` | `[]` | 他の設定にかかわらず、これらは登録しません（`uncage runtimes disable <id>`）。 |
| `agents` | `[]` | 自分で書くエージェント。`enabled`なら必ず登録されます。 |
| `agents[].id` | 必須 | 英小文字、数字、`-`。ランタイムIDは`acp-<id>`です。重複不可。 |
| `agents[].preset` | | `claude`、`gemini`、`opencode`のいずれか。各エントリには`preset`か`command`が必要で、エントリ自身のフィールドが優先されます。 |
| `agents[].displayName` | プリセットの名前、なければID | 最大60文字。 |
| `agents[].command` | プリセットのもの | argv。シェルは通しません。 |
| `agents[].env` | | 追加の環境変数。 |
| `agents[].mcp` | `auto` | [サイトツール](/docs/ja/guides/define-tools/)をエージェントに届ける方法。`off`にすると、このエージェントではサイトツールを使いません。 |
| `agents[].enabled` | `true` | |

エージェントは起動時に`agent.yaml`を読みます。変更したら再起動してください（[変更を反映する](/docs/ja/guides/local-policy/#変更を反映する)を参照）。`uncage setup`と`uncage sites remove`は`runtimes`とコメントを保持します。

このコンピュータが提供するランタイムは`uncage runtimes`で確認できます。

```text
ID          NAME               STATUS         VERSION  SITE TOOLS  RESUME
claude      Claude Code        available      2.1.318  yes         yes
codex       Codex              not installed  -        no          yes
acp-claude  Claude Code (ACP)  available      0.101.0  yes         yes
```

まだ登録されていないレジストリのエージェントと、その有効化の方法も表示されます。`--json`は同じ内容をJSONで出力し、`--all`はインストールされていないレジストリのエージェントも表示し、`--refresh`は先に最新のレジストリをダウンロードします。

### ACPレジストリのエージェント

Uncageには公式ACPレジストリのスナップショット（名前、コマンド、アイコン）が同梱されています。エージェントは1日に最大1回、バックグラウンドでこれを更新します（`UNCAGE_ACP_REGISTRY_REFRESH=0`で無効化）。レジストリにあるものは、確認なしには実行されません。

- このコンピュータにインストール済みのエージェント（このOS向けのバイナリ、またはPATH上の既知のnpm bin）は、ACPハンドシェイクに応答した後にだけ有効になります。レジストリの更新後にコマンドが変わったエージェントは、`uncage runtimes enable`を待ちます。
- `npx`や`uvx`で配布されるエージェントはコードをダウンロードするため、`uncage runtimes enable <id>`を実行するまで決して実行されません。このコマンドは同意した内容を`consented`に記録します。

```sh
uncage runtimes enable gemini    # consent: prints exactly what will run, then registers it
uncage runtimes disable gemini   # never register it
```

Local モード（`uncage serve`）では、`uncage.config.yaml`も同じ`runtimes.acp`ブロックを受け付けます。ただし`enable`と`consented`は無視されます。プロジェクトのファイルが、ダウンロードしたエージェントの実行に同意することはできないからです。`uncage doctor`と`uncage serve`は、プロジェクトのファイルが追加したACP エージェントごとにそのコマンドを表示します。ダウンロードされるエージェントと違い、プロジェクトのファイルの`agents[].command`は同意なしに実行されます。信頼できるプロジェクトでだけ`uncage serve`を実行し、起動時に表示されるコマンドを確認してください。

## プリセット

| プリセット | ランタイム | コマンド | インストール | 状態 |
| --- | --- | --- | --- | --- |
| `claude` | Claude Code (ACP) | `claude-agent-acp` | `npm i -g @agentclientprotocol/claude-agent-acp`（Claude Codeのログインを使用） | `@agentclientprotocol/claude-agent-acp` 0.101.0で**実環境で検証済み**（2026-11-08）：ストリーミング、承認、サイトツール、再開、停止 |
| `gemini` | Gemini CLI (ACP) | `gemini --acp` | `npm i -g @google/gemini-cli` | プロトコル互換、実環境では未検証 |
| `opencode` | OpenCode (ACP) | `opencode acp` | `npm i -g opencode-ai` | プロトコル互換、実環境では未検証 |

コマンドはACPレジストリのエントリと一致しています。Claude Codeを動かすなら、引き続きネイティブのClaude Codeランタイムをおすすめします（モデル、推論の強さ、`plan`、`auto`に対応）。`claude`プリセットは比較用や、ACPアダプターしか使えない環境に向いています。最新の結果は[互換性マトリクス](https://github.com/ptmafia/uncage/blob/main/docs/compatibility.md)にあります。

## ネイティブランタイムとの違い

| | ネイティブのClaude Code | ACP エージェント |
| --- | --- | --- |
| スキル | Claude Codeのスキルとしてインストール（`.claude/skills/`） | ACPにはスキルがないため、セッションフォルダの`.uncage/skills/<name>/`に書き込み、新しいセッションの最初のプロンプトでそれらをパス付きのテキストとして伝えます（`skills: 'prompt'`） |
| ファイルとコマンド | Claude Code自身のツール | エージェントがセッションフォルダで自身のツールを使います。UncageはACPの`fs`や`terminal`のクライアント機能を提供しません |
| 承認 | **Allow once**（許可）/ **Deny**（拒否） | **Allow once**（許可）/ **Deny**（拒否）。Uncageはエージェントの`allow_once`または`reject_once`の選択肢で答え、「常に」系の選択肢は選びません（エージェントがセッションの外に保存するおそれがあるため） |
| パーミッションモード | `default`、`acceptEdits`、`plan`、`auto`、`bypassPermissions` | `default`、`acceptEdits`、そして`localPolicy.allowBypass`のときだけ`bypassPermissions`。Uncage自身がモードを適用し、エージェントに同じIDのモードがあればそれにも切り替えます |
| モデルと推論の強さ | Claude Codeから取得 | 提供しません（エージェント自身のデフォルト） |
| 思考、使用量、スラッシュコマンド | 思考は表示しません | 表示しません |
| 計画 | — | 出力がチェックリストの「Plan」ステップ1つ |
| サイトツール | プロセス内のMCPサーバー | 実行ごとにループバックのMCPサーバーを1つ立て、使い捨てのbearerトークン付きで、`mcpServers`の`site`としてエージェントに渡します（エージェントが対応していればHTTP、そうでなければ小さなstdioブリッジ経由）。`requiresConfirmation`のツールは、呼び出しのたびにUncageで確認します |
| 再開 | 常に可能 | エージェントが`session/resume`か`session/load`に対応している場合のみ。対応していなければ次のメッセージで新しい会話が始まり、`acp_resume_unsupported`の警告が出ます |
| 添付ファイル | 画像とファイル | エージェントが受け付ければ画像を送り、それ以外のファイルはパスへのリンクとして送ります |

ランタイムごとに1つのエージェントプロセスが最初の利用時に起動し、すべてのセッションで共有されます。終了した場合は再起動されます。停止すると`session/cancel`を送り、10秒以内にエージェントが止まらなければそのプロセスグループを終了します。

## トラブルシューティング

| 症状 | 対処 |
| --- | --- |
| ランタイムが`not_installed`（未インストール）と表示される | コマンドがPATH上にありません。エージェントをインストールする（ヒントに方法が表示されます）か、`command`に絶対パスを書いてから、エージェントを再起動してください。 |
| 実行が`auth_required`で失敗する | エージェント自身のログインが必要です。ターミナルでエージェント自体を使ってサインインし（たとえば`claude`を起動して`/login`、または`gemini`）、やり直してください。Uncageがエージェントの認証情報を扱うことはありません。 |
| 「The agent did not answer initialize within 15000 ms」 | コマンドは起動しましたが、ACPに対応していません（フラグの誤り、古いバージョン、入力待ちのプロンプトなど）。コマンドを手で実行してみてください。stdinのJSONを黙って待つのが正常です。 |
| レジストリのエージェントが`available`のまま登録されない | `npx`/`uvx`で配布されているか、レジストリの更新後にコマンドが変わりました。使いたい場合は`uncage runtimes enable <id>`を実行してください。 |
| ランタイムが表示されない | `uncage runtimes`（と`uncage runtimes --all`）を確認してください。無効化されている、`enabled: false`、または`presets: off`の可能性があります。`uncage doctor`はACP エージェントごとに`runtime.acp-<id>`の行を表示しますが、これらの行でチェックが失敗することはありません。 |
| サイトツールが呼ばれない | そのエージェントが`mcp: off`か、エージェントがMCPサーバーに対応していません。`mcp: stdio`でstdioブリッジを試してください。 |
| モードの変更時に実行が`policy_denied`で失敗する | エージェントがウェブサイトのパーミッションモードに切り替えられず、より緩いモードのままになるためです。 |

## 確認

1. `uncage runtimes`でエージェントが`available`と表示され、バージョンが出ます。`mcp: off`にしていなければ`SITE TOOLS`は`yes`です。
2. `uncage doctor`に`✓ Runtime acp-<id>`が表示されます。
3. ウェブサイトのランタイム選択に`<name> (ACP)`が表示されます。選んでプロンプトを送ると、回答がストリーミングで表示されます。
4. `default`モードでファイルの変更を頼むと承認カードが表示され、**Allow once**を押すと変更されます。
5. 確認が必要なサイトツールを使わせると、承認カードがちょうど1枚表示され、許可するとツールがウェブサイト上で実行されます。
6. 同じセッションで続けて質問すると、エージェントは前の会話を覚えています（`RESUME`が`yes`の場合）。
7. 時間のかかるコマンドを始めてから**Stop**（停止）を押すと、数秒以内に実行がキャンセルされます。
