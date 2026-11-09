import type { Dict } from './schema.ts';

/**
 * Japanese homepage copy. Native marketing copy written against the English (en.ts), with the same
 * claims. Terminology follows apps/docs/i18n-glossary.md.
 * - The approval buttons stay "Allow once" / "Deny": the real UI (@uncage/react-ui) has no Japanese
 *   strings, so the diagram shows what a Japanese visitor actually sees (allow-listed in tests/i18n.test.ts).
 * - No spaces between Japanese and Latin words; the spacing comes from `text-autospace` (global.css).
 */
export const pending = false;

export const ja: Dict = {
  meta: {
    title: 'Uncage：あなたのコーディングエージェントを、どこでも',
    description:
      'Uncageなら、あなたのウェブサイトから、各ユーザーのコンピュータで動く本人のClaude Codeを操作できます。リアルタイムのストリーミング、承認、サイトツールとスキルに対応し、成果はあなたのサイトに届きます。オープンソース（MIT）。',
    ogAlt: 'Uncage。あなたのコーディングエージェントを、どこでも。ローカルハーネスを、サービスとして。',
  },
  tagline: 'ローカルハーネスを、サービスとして。',
  a11y: {
    skip: '本文へスキップ',
    home: 'Uncageホーム',
    mainNav: 'メイン',
    menu: 'メニュー',
    language: '言語',
    copy: 'コピー',
    copied: 'コピーしました',
    external: '新しいタブで開きます',
    installOs: 'OSの選択',
  },
  nav: {
    product: '製品',
    how: '仕組み',
    security: 'セキュリティ',
    docs: 'ドキュメント',
    demo: 'デモ',
    tryDemo: 'デモを試す',
  },
  langHint: {
    text: 'このページは日本語でもご覧いただけます。',
    switch: '日本語で読む',
    dismiss: '閉じる',
  },
  hero: {
    eyebrow: 'v0.3 · サーバーレスに対応',
    title: 'あなたの|コーディング|エージェントを、|*どこでも。*',
    lede: 'ユーザーの手元には、すでに強力な環境があります。本人のClaude Code、ログイン済みのアカウント、使い慣れたツール。Uncageは、そのローカルハーネスを、あなたのプロダクトから呼び出せるサービスに変えます。処理はユーザーのコンピュータで実行され、成果はあなたのサイトに届きます。',
    primary: 'ライブデモを試す',
    secondary: '数分で導入',
    installLabel: 'コマンド1つ、承認1回',
  },
  flow: {
    label: 'リクエストの流れ：あなたのサイトのチャット、ユーザーのコンピュータから接続するWebSocketまたはHTTPSストリーミング、そしてそのコンピュータで動くClaude Code。',
    browserTitle: 'your.site',
    online: 'コンピュータはオンライン',
    userMessage: 'ローンチ用のランディングページを作って、公開して',
    toolNote: 'あなたのサーバーで実行',
    assistant: 'ページができました。サイトに公開しますか？',
    allow: 'Allow once',
    deny: 'Deny',
    wire: 'WebSocketまたはHTTPSストリーミング（ユーザーのコンピュータから接続）',
    termSkill: 'スキルを読み込み',
    termWrite: '書き込み',
    termWaiting: '承認待ち…',
  },
  why: {
    kicker: 'Uncageを選ぶ理由',
    title: 'ユーザーの環境を、クラウドに作り直さない。',
    titleLine2: 'すでにある環境に、つなぐだけ。',
    sub: 'クラウドのエージェントサンドボックスは毎回ゼロから始まり、トークンの費用はすべてあなた持ち。Uncageは何も借りず、何もホストしません。ユーザーがすでに信頼しているエージェントを、あなたのプロダクトから動かせるようにするだけです。',
    sandbox: {
      title: 'ホスト型エージェントサンドボックス',
      points: [
        '実行のたびに作り直される、空の環境',
        'ユーザーの認証情報とコードをあなたが預かる',
        '計算資源とモデル呼び出しの費用はすべてあなた持ち',
        'データの経路に、ベンダーがもう1社増える',
      ],
    },
    uncage: {
      title: 'Uncage：ユーザー自身のハーネス',
      points: [
        '本人のClaude Code、設定、MCPサーバー、リポジトリ',
        '本人のログインのまま。あなたと共有されず、あなたが保存することもない',
        'あなた側のモデル費用はゼロ',
        'サイトに届くのは、会話に表示された内容とあなたのツールが取得したものだけ',
      ],
    },
  },
  how: {
    kicker: '仕組み',
    title: '構成要素は3つ。プロトコルは1つ。',
    sub: 'ブラウザが話す相手はあなたのサイト。あなたのサイトは、ユーザーのコンピュータが自ら開いたWebSocketまたはHTTPSストリームで、そのコンピュータと話します。経路はそれだけです。',
    steps: [
      {
        tag: '接続',
        title: 'ユーザーがコンピュータをつなぐ',
        body: 'コマンドを1つ実行し、ブラウザで1回承認するだけ。バックグラウンドのエージェントがあなたのサイトへ自ら接続するため、ポートを開ける必要はありません。',
      },
      {
        tag: '指示',
        title: 'あなたのサイトが指示を出す',
        body: 'プロダクト内のチャットから実行を開始し、すべてのステップをストリーミング表示。「Allow / Deny」の承認カードも表示します。',
      },
      {
        tag: '成果',
        title: '成果があなたのサイトに届く',
        body: 'Claude Codeがあなたのツールとスキルを呼び出します。ハンドラーはあなたのバックエンドで、ログイン中のユーザーとして実行されます。',
      },
    ],
  },
  features: {
    kicker: '機能',
    title: 'プロダクトとユーザーのエージェントをつなぐ、すべてを。',
    sub: 'オープンソースの部品群。デフォルトのUIをそのまま使うことも、hooksでヘッドレスに組むこともできます。',
    availableLabel: '提供中',
    soonLabel: '近日公開',
    soonBadge: '近日公開',
    available: [
      {
        title: 'ストリーミングと承認',
        body: 'トークンもツールのステップも、すべてリアルタイムでUIへ。リスクのある操作は「Allow / Deny」カードで承認を待ちます。',
      },
      {
        title: 'サイトツール',
        body: 'zodスキーマで機能を宣言するだけ。Claude CodeからはMCPツールとして見え、ハンドラーはあなたのサーバーで動きます。',
      },
      {
        title: 'スキル',
        body: '社内ルールやテンプレートをMarkdownで配布。実行ごとに読み込まれ、コードとして実行されることはありません。',
      },
      {
        title: '保存先を選べる',
        body: '履歴はユーザーのコンピュータに残すことも、あなたのサイトへ複製してセッション後も残すこともできます。',
      },
      {
        title: 'すぐ使えるReact UI',
        body: 'Claude Code風のコンポーザー。モデル、推論の強さ、パーミッションモード、ファイル添付、音声入力に対応。',
      },
      {
        title: 'どこでも動く',
        body: '常時稼働のNodeサーバー、Vercel、Cloudflare Workers、あらゆるFetchプラットフォームで動作。FaaSモードに必要なのはPostgresだけ。Redisを足せばスケールアウトできます。',
      },
      {
        title: 'あらゆるACPエージェント',
        body: 'ACPアダプター経由のClaude Code（実機で検証済み）と、Gemini CLIやOpenCodeなどAgent Client Protocolに対応したエージェントが、ランタイムの選択肢に表示されます。',
      },
      {
        title: 'macOS・Windows・Linux',
        body: 'macOS、Windows、Linuxのどれでも、コマンド1つで必要なものがすべて入ります。エージェントはユーザーごとのバックグラウンドサービスとして動きます。macOSとLinuxではsudoは不要、Windowsはユーザー単位のインストールです。macOSは実機で検証済みで、WindowsとLinuxはCIで検証済み、実機での確認待ちです。',
      },
    ],
    soon: [
      {
        title: 'Codexの実機検証',
        body: 'Codexアダプターは提供中で、シミュレーションサーバーでテスト済み。次は実際のバイナリでの検証です。',
      },
      {
        title: 'その他の入口',
        body: 'モバイルアプリ、チャットアプリ、ブラウザ拡張から、同じローカルハーネスを動かす。',
      },
    ],
  },
  code: {
    kicker: '開発者向け',
    title: 'ハブをマウントして、チャットを置く。',
    sub: '認証も、データベースも、サーバーや関数プラットフォームも、今あるものをそのまま。Uncageは既存の構成に組み込めます。',
    moreTitle: 'ゼロから、コンピュータの接続まで',
    moreBody: 'クイックスタートでは、ハブ、デバイスの承認ページ、最初のサイトツールを備えたNext.jsアプリを順を追って作ります。Express、Fastify、Honoでも動きます。',
    more: 'Connectedモードのクイックスタートへ',
  },
  security: {
    kicker: 'セキュリティ',
    title: '自分のコンピュータの主導権は、ユーザーに。',
    sub: 'ウェブサイトが送るのはデータだけで、コードは送りません。最終判断は常にローカルで。',
    points: [
      {
        title: 'コードではなくデータ',
        body: 'ハブが送るのは、ツールのスキーマ、スキルのテキスト、決まった種類のコマンドだけ。ウェブからシェルを操作する手段はありません。',
      },
      {
        title: '本人のログインだけ',
        body: '各コンピュータで動くのは、その持ち主のClaude Code。共有キーはありません。',
      },
      {
        title: 'ローカルポリシーが優先',
        body: '権限確認のバイパスは、ユーザーのコンピュータ上のファイルでしか有効にできません。',
      },
      {
        title: 'アクティビティログ',
        body: '{activity}で、各サイトが何を要求したかを確認できます。',
      },
    ],
    more: 'トラストモデルを読む',
  },
  final: {
    title: 'ユーザーのエージェントを、あなたのプロダクトで活かそう。',
    sub: 'MITライセンス · npmで12パッケージを公開 · 開発者とコーディングエージェントのために',
    primary: 'ライブデモを試す',
    secondary: 'ドキュメントを読む',
  },
  footer: {
    product: '製品',
    developers: '開発者',
    project: 'プロジェクト',
    features: '機能',
    quickstart: 'クイックスタート',
    api: 'APIリファレンス',
    forAgents: 'コーディングエージェント向け',
    changelog: '変更履歴',
    license: 'MITライセンス',
    rights: 'MITライセンスで公開しています。',
  },
  notFound: {
    title: 'ページが見つかりません',
    body: 'お探しのページは存在しないか、移動した可能性があります。',
    home: 'ホームに戻る',
    docs: 'ドキュメントを開く',
  },
};
