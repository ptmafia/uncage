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
| approval card | 审批卡片 | 承認カード | UI buttons: 允许执行 / 拒绝, 許可 / 拒否. |
| workspace | 工作区 | ワークスペース | |
| local policy | 本地策略 | ローカルポリシー | `localPolicy` in `~/.uncage/agent.yaml`. |
| activity log | 活动日志 | アクティビティログ | `uncage activity`. |
| manifest | 清单 | マニフェスト | The tools and skills offered to one run. |
| permission mode | 权限模式 | パーミッションモード | |
| bypass (permissions) | 绕过权限 | バイパス（権限確認の省略） | Mode `bypassPermissions`. |
| agent (the background process) | 守护进程（agent） | エージェント（バックグラウンドプロセス） | Matches the existing zh UI word. |
| website / site | 网站 | ウェブサイト | |
| computer online / offline | 在线 / 离线 | オンライン / オフライン | |
