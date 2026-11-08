---
title: Uncage
description: ウェブサイトから、ユーザー自身のコンピュータ上のClaude Codeを動かします。処理はユーザーのコンピュータで行われ、会話・承認・成果物はあなたのサイトに残ります。
template: splash
hero:
  tagline: 指示を出すのはあなたのウェブサイト。作業するのは、ユーザー自身のコンピュータで動く、そのユーザーのClaude Code。Claude Codeはあなたのウェブサイトのツールを呼び出します。過程も成果物もサイトに残ります。
  actions:
    - text: Connected モード クイックスタート
      link: /docs/ja/start/quickstart-connected/
      icon: right-arrow
    - text: 仕組み
      link: /docs/ja/start/how-it-works/
      variant: minimal
    - text: コーディングエージェント向け
      link: /docs/ja/start/for-coding-agents/
      variant: minimal
---

## Uncageとは

Uncageは、Claude Code（およびCodex）を、あなた自身のウェブUIから使えるようにするnpmパッケージ群です。承認、ストリーミング、停止（Stop）、リロードしても消えない履歴を備えています。

モードは2つあります。どちらも同じプロトコル、同じReact hooks、同じ`<AgentChat>` UIを使います。

| | **Connected モード**（0.2で追加） | **Local モード** |
| --- | --- | --- |
| エージェントを動かす人 | 各エンドユーザー。自分のコンピュータで、自分のClaude Codeのログインを使います | あなた。アプリを動かしているマシンで実行します |
| サイトに追加するもの | Nodeバックエンドに`@uncage/hub`、ページに`<AgentChat>`、`/device`に承認ページ | 同一オリジンのプロキシルートと`<AgentChat>` |
| ユーザーが行うこと | 2つのコマンドを一度だけ実行します：`curl -fsSL https://your.site/api/uncage/install.sh \| bash`、続けて`uncage setup https://your.site` | なし。あなたのマシンです |
| 向いている用途 | ユーザーがClaude Codeを持っていて、あなたのプロダクトと連携させたいSaaS | 社内ツール、デスクトップ型アプリ、開発者向けダッシュボード |

## ユーザーが得られるもの

- **ユーザー自身の**Claude Codeを動かす、あなたのウェブサイト上のチャット。あなたのサーバーで動くのはあなた自身のコードだけです。
- 回答とすべてのツールステップのライブストリーミング。
- コマンド、ファイル編集、確認が必要なあなたのツールに対する**Allow / Deny**（許可／拒否）のカード。
- 停止、添付ファイル、モデル・Effort・パーミッションモードの選択、リロードしても残る履歴。
- サイトストレージを有効にすれば、ユーザーのコンピュータの電源が切れていても、会話はサイト上で読めます。

## ウェブサイト側が得られるもの

- **サイトツール**。`defineTool`（名前、zodスキーマ、ハンドラー）で機能を宣言します。Claude CodeからはMCPツールとして見えます。ハンドラーは**あなたのバックエンドで、サインイン中のユーザーとして**実行され、実行（Run）のワークスペースからファイルを取得できます（`ctx.files.pull`）。
- **スキル**。社内ルールやテンプレートをプレーンなMarkdownでClaude Codeに渡せます。Claude Codeは通常のスキルと同じように読み込みます。
- **実行ごとの選択**。`selectManifest`が、プロンプトとユーザーに応じて実行ごとのツールとスキルを選びます。
- **認証もストレージもスケールも自前で**。`getUser(req)`で既存のサインインを接続します。PostgresとRedisのアダプターを使えば、ロードバランサーの背後で複数ノードのハブを動かせます。

## Uncageが決してしないこと

- ウェブサイトからユーザーのコンピュータへコードやシェルコマンドを送ることはありません。ハブが送るのはデータだけです：ツール名とスキーマ、スキルのテキスト、そして「実行を開始する」などの固定されたコマンドです。
- 1つのClaudeログインを複数のユーザーで共有することはありません。各コンピュータは、その所有者自身のClaude Codeを使います。
- ウェブサイトが「権限確認のバイパス」を有効にすることはできません。有効にできるのはユーザーだけで、ユーザー自身のコンピュータ上のファイルで設定します。

一覧は[トラストモデル](/docs/ja/concepts/trust-model/)を参照してください。

## どこから始めるか

- **ウェブサイトを構築する場合**：[仕組み](/docs/ja/start/how-it-works/)を読んでから、[Connected モード クイックスタート](/docs/ja/start/quickstart-connected/)を進めてください（約15分）。
- **エージェントをアプリと同じマシンで動かす場合**：[Local モード クイックスタート](/docs/ja/start/quickstart-local/)は5分で終わります。
- **コーディングエージェントを使う場合**：[Uncageスキル](/docs/skills/uncage/SKILL.md)または[`llms.txt`](/docs/llms.txt)を渡してください。どのページもURLに`.md`を付ければプレーンなMarkdownで取得できます。[コーディングエージェント向け](/docs/ja/start/for-coding-agents/)を参照してください。

:::note[ステータス]
Connected モードはUncage 0.2に含まれます（`@uncage/hub`、`@uncage/agent`、および`@uncage/cli`の`uncage setup` / `uncage agent`コマンド）。エージェント側は**macOS**のみで動作し、Node.js 22以降が必要です。Claude Codeは実環境で検証済みです。Codexは実装済みですが実際のバイナリでの動作確認はまだで、サイトツールにも未対応です。詳細：[互換性](https://github.com/ptmafia/uncage/blob/main/docs/compatibility.md)。
:::
