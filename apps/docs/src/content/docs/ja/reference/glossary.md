---
title: 用語集
description: Uncageのすべての用語（エージェント、コンピュータ、ハブ、サイトツール、スキル、マニフェスト、ファイルチャネル、サイトストレージ、クラスター、パーミッションモード、Local モードとConnected モード）の1行定義と、正確なAPI名、中国語のUI文言をまとめています。
---

このサイト、UI、APIで使われる言葉は、どこでも同じ意味です。「UIの文言」列は、`@uncage/react-ui`でエンドユーザーに表示される文言です（English / 简体中文）。

| 用語 | 定義 | API名 | UIの文言 |
| --- | --- | --- | --- |
| **Connected モード**（Connected Mode） | ウェブサイトが、ハブを通じて各ユーザー自身のコンピュータ上のClaude Codeを動かします。 | `@uncage/hub`、`@uncage/agent` | |
| **Local モード**（Local Mode） | アプリが、ローカルデーモンと同一オリジンのプロキシを通じて、自身が動いているマシン上のClaude Codeを動かします。 | `uncage serve`、`createUncageHandler` | |
| **ウェブサイト／サイト**（Website / site） | あなたのウェブアプリケーション。ハブを1つ動かします。コンピュータはサイトのIDと名前でウェブサイトを識別します。 | `HubOptions.site`、`publicUrl` | site / 网站 |
| **ハブ**（Hub） | ウェブサイトのNodeバックエンドにマウントするUncageの部品：デバイスログイン、コンピュータとの接続、ブラウザ向けAPI、サイトツール。 | `createHub()`、`Hub` | |
| **ベースパス**（Base path） | ハブをマウントする場所。 | `basePath`、デフォルトは`/api/uncage` | |
| **コンピュータ／マシン**（Computer / machine） | あなたのウェブサイトに接続された1人のユーザーのコンピュータ。APIでは「machine」、UIでは「computer」と呼びます。 | `MachineInfo`、`machineId`、`useMachines()` | computer / 电脑 |
| **エージェント**（Agent） | ユーザーのコンピュータ上でハブに接続し、Claude Codeを実行するバックグラウンドプロセス。 | `uncage agent`、`@uncage/agent` | the agent / 守护进程 |
| **オンライン**（Online） | コンピュータのWebSocketが接続されていて、ハートビートに応答している状態。応答が途絶えると約30秒以内にオフラインになります。 | `MachineInfo.online` | online / 在线、offline / 离线 |
| **ペアリング／デバイスログイン**（Pairing / device login） | コンピュータをユーザーに紐づけること：`uncage setup`がコードを取得し、ユーザーが`/device`でそれを承認します。 | `approveDevice`、`lookupDevice`、`denyDevice` | |
| **ユーザーコード**（User code） | ユーザーが照合して承認する8文字のコード（`ABCD-2345`）。有効期間は10分です。 | `?code=` | |
| **承認ページ**（Approval page） | サインイン中のユーザーがコードを承認する、あなたの`/device`ページ。 | `verificationPath`、`<ApproveDevice>` | |
| **マシントークン**（Machine token） | コンピュータが1つのウェブサイトに接続するときに使う秘密の値。`~/.uncage/agent.yaml`にのみ保存されます。 | | |
| **取り消し**（Revoke） | コンピュータをウェブサイトから完全に切断すること。そのトークンは使えなくなります。 | `revokeMachine`、`uncage sites remove` | |
| **ランタイム**（Runtime） | 実際に作業するコーディングエージェント：Claude Code（`claude`）またはCodex（`codex`）。 | `RuntimeInfo`、`RuntimeAdapter` | |
| **セッション**（Session） | 1台のコンピュータ上で1つのランタイムと行う1つの会話。 | `Session`、`sessionId` | session / 会话 |
| **ワークスペース**（Workspace） | セッションが作業するフォルダ。Connected モードでは`~/Uncage/<site host>/<session id>/`です。 | `Session.workspace` | |
| **実行**（Run） | 1つのプロンプトと、それに答えるためにエージェントが行うすべての処理。 | `Run`、`runId`、`RunState` | |
| **イベント**（Event） | セッションで起きた、番号付きの1つの出来事。SSEでストリーミングされます。 | `UncageEvent`、`sequence` | |
| **シーケンス**（Sequence） | セッションごとのイベント番号。再開とレプリケーションに使われます。 | `UncageEvent.sequence`、`Last-Event-ID` | |
| **承認**（Approval） | ある操作を許可するか拒否するかをユーザーに求めるリクエスト。 | `ApprovalRequest`、`useApprovals()` | Allow once / Deny, 允许执行 / 拒绝 |
| **パーミッションモード**（Permission mode） | どこまで承認を求めるか：`default`、`acceptEdits`、`plan`、`auto`、`bypassPermissions`。 | `PermissionMode`、`useSessionSettings()` | |
| **権限確認のバイパス**（Bypass permissions） | 承認を一切求めないモード。許可できるのはユーザーだけで、ユーザー自身のコンピュータで設定します。 | `localPolicy.allowBypass` | |
| **サイトツール**（Site tool） | Claude Codeが呼び出せる、あなたのウェブサイトの機能。ハンドラーはあなたのサーバーで、そのユーザーとして実行されます。 | `defineTool()`、`SiteTool`、`ToolContext` | |
| **確認**（Confirmation） | 呼び出しのたびにユーザーに確認するサイトツール。 | `requiresConfirmation: true` | |
| **スキル**（Skill） | Markdownの指示と任意のテンプレートファイル。関連する場面でClaude Codeが読み込みます。 | `SkillSpec`、`skills` | |
| **マニフェスト**（Manifest） | 1つの実行に提供されるツールとスキル。 | `selectManifest()`、`SessionManifest` | |
| **ファイルチャネル**（File channel） | ツールのハンドラーが、コンピュータ上の実行のワークスペースからファイルを読み取る仕組み。 | `ctx.files.pull()`、`ctx.files.read()` | |
| **サイトストレージ**（Site storage） | ハブがすべての会話のレプリカを保持し、コンピュータの電源が切れていても読めるようにすること。 | `sessionStorage: 'site'` | |
| **ハブストア**（Hub store） | ハブのデータベース：コンピュータ、セッションインデックス、ツール呼び出しの監査記録、レプリカ。 | `HubStore`、`pgliteHubStore`、`postgresHubStore` | |
| **ノード**（Node） | 1つのハブプロセス。複数のノードがストアとクラスターアダプターを共有します。 | | |
| **クラスターアダプター**（Cluster adapter） | ハブノード間でプレゼンスを共有し、メッセージを運びます。 | `ClusterAdapter`、`memoryCluster`、`redisCluster` | |
| **ローカルポリシー**（Local policy） | すべてのウェブサイトに対して、ユーザーが自分のコンピュータで設定する制限。 | `~/.uncage/agent.yaml`の`localPolicy` | |
| **アクティビティログ**（Activity log） | ウェブサイトがコンピュータ上で行ったすべてのことのローカル記録。 | `uncage activity` | |
| **デーモン**（Daemon） | Local モードのサーバー。`127.0.0.1:4783`で動く`uncage serve`です。 | `@uncage/server` | |
| **プロキシ**（Proxy） | Local モードで、アプリ内に置く同一オリジンのルート。トークンを付けてデーモンへ転送します。 | `createUncageHandler`、`createUncageNodeHandler` | |
| **ドラフト**（Draft） | 最初のプロンプトを送る前の、UI上の作成予定のセッション。設定とファイルを保持します。 | `openDraft()`、`commitDraft()`、`isDraft` | |
