# Translation glossary

Fixed terms for the zh-CN and ja versions of the help site. Use the same word for the same thing on every page, in the UI strings of `@uncage/react-ui` and in the demo. Keep API names, commands, file paths and code in English.

Rules for translators:

- Code blocks are identical to English (`scripts/check-i18n.ts` enforces it). Translate comments only if the English page's block cannot be shared; otherwise leave them.
- Internal links keep their path and get the locale prefix: `/docs/guides/x/` → `/docs/zh-cn/guides/x/`, `/docs/ja/guides/x/`.
- Product and package names (Uncage, Claude Code, Codex, `@uncage/hub`) stay in English.
- English-only pages (`api/**`, `reference/changelog`, `guides/ci-and-releases`) are not translated.

| English | 简体中文 (zh-CN) | 日本語 (ja) | Notes |
| --- | --- | --- | --- |
| hub | hub（保持英文） | ハブ | `@uncage/hub`, `createHub()` stay as is. In ja, write 「ハブ」, first use「ハブ（`@uncage/hub`）」. |
| site tool(s) | 网站工具 | サイトツール | Defined with `defineTool()`. |
| skill(s) | 技能 | スキル | |
| Connected Mode | Connected 模式 | Connected モード | Keep the mode name in English, add 模式 / モード. |
| Local Mode | Local 模式 | Local モード | |
| device approval | 设备授权 | デバイスの承認 | The `/device` page; verb: 授权 / 承認する. |
| machine | 电脑（API 中为 machine） | コンピュータ（API では machine） | “computer” in the UI, “machine” in the API. |
| run | 运行 | 実行（Run） | One prompt and everything the agent does. Use 「Run」 for the API object in ja when ambiguous. |
| session | 会话 | セッション | |
| approval card | 审批卡片 | 承認カード | UI buttons: 允许执行 / 拒绝 (zh); ja keeps the English labels **Allow once**（許可）/ **Deny**（拒否）, see “UI labels in prose”. |
| workspace | 工作区 | ワークスペース | |
| local policy | 本地策略 | ローカルポリシー | `localPolicy` in `~/.uncage/agent.yaml`. |
| activity log | 活动日志 | アクティビティログ | `uncage activity`. |
| manifest | 清单 | マニフェスト | The tools and skills offered to one run. |
| permission mode | 权限模式 | パーミッションモード | |
| ACP agent | ACP agent（保持英文） | ACP エージェント | An agent that speaks the Agent Client Protocol (`runtimes.acp`). ja: no space before ACP after Japanese text (あらゆるACP エージェント). |
| preset | 预设 | プリセット | The built-in ACP agent entries (`claude`, `gemini`, `opencode`). |
| Agent Client Protocol | Agent Client Protocol（保持英文） | Agent Client Protocol（英語のまま） | The protocol name stays in English; the abbreviation ACP too. |
| bypass (permissions) | 绕过权限（UI 显示为「完全放行」） | バイパス（権限確認の省略） | Mode `bypassPermissions`. |
| agent (the background process) | 守护进程（agent） | エージェント（バックグラウンドプロセス） | Matches the existing zh UI word. |
| website / site | 网站 | ウェブサイト | |
| computer online / offline | 在线 / 离线 | オンライン / オフライン | |
| composer | 输入框 | コンポーザー | The prompt box of `<AgentChat>` with its pickers. ja may say プロンプト入力欄 only when describing the text box itself. |
| draft (session before the first prompt) | 草稿 | ドラフト | `openDraft()` / `commitDraft()`. |
| folder | 目录（偶尔用“文件夹”） | フォルダ | ja: not フォルダー. |
| machine token | 机器令牌 | マシントークン | |
| machine ID | machine id（保持英文） | マシンID | ja: no space between マシン and ID (same for ランタイムID). |
| trust model | 信任模型 | トラストモデル | The page `concepts/trust-model`. ja: not 信頼モデル. |
| source of truth | 以……为准 | 正となるデータ | E.g. the computer's local database. ja: not 信頼できる唯一の情報源. |
| UI labels in prose | Real Chinese UI labels (允许执行 / 拒绝, 批准, 素材) | English UI label + Japanese gloss on first use: **Allow once**（許可）/ **Deny**（拒否） | `@uncage/react-ui` has no Japanese strings. The connected demo's UI is Chinese: en/ja pages quote the Chinese label with a gloss, e.g. **允许执行** (Allow once), **允许执行**（1回だけ許可）. |
