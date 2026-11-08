---
title: 用語集
description: Uncageのすべての用語（エージェント、コンピュータ、ハブ、デプロイモード、トランスポート、サイトツール、スキル、マニフェスト、ファイルチャネル、サイトストレージ、クラスター、パーミッションモード、Local モードとConnected モード）の1行定義と、正確なAPI名、中国語のUI文言をまとめています。
---

このサイト、UI、APIで使われる言葉は、どこでも同じ意味です。「UIの文言」列は、`@uncage/react-ui`でエンドユーザーに表示される文言です（English / 简体中文）。

| 用語 | 定義 | API名 | UIの文言 |
| --- | --- | --- | --- |
| **Connected モード**（Connected Mode） | ウェブサイトが、ハブを通じて各ユーザー自身のコンピュータ上のClaude Codeを動かします。 | `@uncage/hub`、`@uncage/agent` | |
| **Local モード**（Local Mode） | アプリが、ローカルデーモンと同一オリジンのプロキシを通じて、自身が動いているマシン上のClaude Codeを動かします。 | `uncage serve`、`createUncageHandler` | |
| **ウェブサイト／サイト**（Website / site） | あなたのウェブアプリケーション。ハブを1つ動かします。コンピュータはサイトのIDと名前でウェブサイトを識別します。 | `HubOptions.site`、`publicUrl` | site / 网站 |
| **ハブ**（Hub） | ウェブサイトのバックエンドにマウントするUncageの部品：デバイスログイン、コンピュータとの接続、ブラウザ向けAPI、サイトツール。Fetchハンドラーです。 | `createHub()`、`Hub`、`hub.fetch()` | |
| **デプロイモード**（Deployment mode） | ハブをどこで、どう動かすか：従来モードかFaaS モード。 | | |
| **従来モード（常駐プロセス）**（Traditional mode） | 常駐するNodeプロセスで動くハブ：組み込みのストア、WebSocket、外部依存なし。 | `@uncage/hub/node`：`toNodeHandler`、`attachWebSocket`、`pgliteHubStore` | |
| **FaaS モード**（FaaS mode） | サーバーレス関数やFetch対応プラットフォーム（Vercel、Cloudflare Workers）で動くハブ：Postgres、HTTPストリーミング。 | `toNextHandlers`、`fetchOnce`、`postgresHubStore`、`postgresCluster` | |
| **関数インスタンス**（Function instance） | 動いているサーバーレス関数の1つのコピー。FaaS モードでは、各インスタンスがハブのノードです。 | | |
| **トランスポート**（Transport） | コンピュータとハブをつなぐ方式：WebSocket（`ws`）またはHTTPストリーミング（`http`）。ハブが提供し、エージェントが選びます。 | `TransportKind`、`transports`、`GET /agent/info` | |
| **HTTPストリーミング**（HTTP streaming） | `http`トランスポート：下り方向は長時間の`GET /agent/stream`（プラットフォームの制限より前に開き直し）、上り方向は`POST /agent/events`。 | `stream.maxDurationMs`、`polling` | |
| **アウトボックス**（Outbox） | ハブのストアにある、1台のコンピュータ向けの永続的な番号付きのコマンドのキュー。エージェントはカーソルから再開します。 | `OutboxItem`、`cursor`、`ack` | |
| **メンテナンス**（Maintenance） | ハブの定期的な後始末（保持期間の管理、停止したインスタンスの呼び出しを失敗として処理）。全インスタンスを通じて間隔ごとに最大1回実行されます。 | `maintenance`、`hub.maintain()`、`/maintenance` | |
| **ベースパス**（Base path） | ハブをマウントする場所。 | `basePath`、デフォルトは`/api/uncage` | |
| **コンピュータ／マシン**（Computer / machine） | あなたのウェブサイトに接続された1人のユーザーのコンピュータ。APIでは「machine」、UIでは「computer」と呼びます。 | `MachineInfo`、`machineId`、`useMachines()` | computer / 电脑 |
| **エージェント**（Agent） | ユーザーのコンピュータ上でハブに接続し、Claude Codeを実行するバックグラウンドプロセス。 | `uncage agent`、`@uncage/agent` | the agent / 守护进程 |
| **オンライン**（Online） | コンピュータの接続が生きている状態（ハートビートに応答しているWebSocket、または開いているHTTPストリーム）。通信が途絶えると約30秒以内にオフラインになります。 | `MachineInfo.online`、`MachineInfo.transport` | online / 在线、offline / 离线 |
| **エージェントの更新が必要**（Agent update needed） | コンピュータのエージェントが、ハブの`minAgentVersion`より古い状態。 | `MachineInfo.agentOutdated`、`upgrade_required` | Agent update needed / 需要更新守护进程 |
| **ペアリング／デバイスログイン**（Pairing / device login） | コンピュータをユーザーに紐づけること：`uncage setup`がコードを取得し、ユーザーが`/device`でそれを承認します。 | `approveDevice`、`lookupDevice`、`denyDevice` | |
| **ユーザーコード**（User code） | ユーザーが照合して承認する8文字のコード（`ABCD-2345`）。有効期間は10分です。 | `?code=` | |
| **承認ページ**（Approval page） | サインイン中のユーザーがコードを承認する、あなたの`/device`ページ。 | `verificationPath`、`<ApproveDevice>` | |
| **マシントークン**（Machine token） | コンピュータが1つのウェブサイトに接続するときに使う秘密の値。`~/.uncage/agent.yaml`にのみ保存されます。 | | |
| **取り消し**（Revoke） | コンピュータをウェブサイトから完全に切断すること。そのトークンは使えなくなります。 | `revokeMachine`、`uncage sites remove` | |
| **ランタイム**（Runtime） | 実際に作業するコーディングエージェント：Claude Code（`claude`）、Codex（`codex`）、またはACP エージェント（`acp-<id>`）。 | `RuntimeInfo`、`RuntimeAdapter` | |
| **ACP エージェント**（ACP agent） | Agent Client Protocolを話すあらゆるコーディングエージェント（Gemini CLI、OpenCodeなど）。ランタイムとして提供されます。 | `runtimes.acp`、`uncage runtimes` | |
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
| **ハブストア**（Hub store） | ハブのデータベース：コンピュータ、セッションインデックス、アウトボックス、ツール呼び出しの状態と監査記録、レート制限のカウンター、レプリカ。 | `HubStore`、`pgliteHubStore`、`postgresHubStore` | |
| **ノード**（Node） | 1つのハブプロセスまたは関数インスタンス。複数のノードがストアとクラスターアダプターを共有します。 | | |
| **クラスターアダプター**（Cluster adapter） | ハブノード間でプレゼンスを共有し、メッセージを運びます。 | `ClusterAdapter`、`memoryCluster`、`redisCluster`、`postgresCluster` | |
| **ローカルポリシー**（Local policy） | すべてのウェブサイトに対して、ユーザーが自分のコンピュータで設定する制限。 | `~/.uncage/agent.yaml`の`localPolicy` | |
| **アクティビティログ**（Activity log） | ウェブサイトがコンピュータ上で行ったすべてのことのローカル記録。 | `uncage activity` | |
| **デーモン**（Daemon） | Local モードのサーバー。`127.0.0.1:4783`で動く`uncage serve`です。 | `@uncage/server` | |
| **プロキシ**（Proxy） | Local モードで、アプリ内に置く同一オリジンのルート。トークンを付けてデーモンへ転送します。 | `createUncageHandler`、`createUncageNodeHandler` | |
| **ドラフト**（Draft） | 最初のプロンプトを送る前の、UI上の作成予定のセッション。設定とファイルを保持します。 | `openDraft()`、`commitDraft()`、`isDraft` | |
