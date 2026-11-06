# @uncage/react-ui

The default chat UI: `<AgentChat>` (session sidebar, runtime selector, streaming markdown, tool steps, approval cards, Stop, run status) inside `<UncageProvider>`.

The composer is styled after Claude Code's prompt box. Its toolbar has a model menu, an effort menu and a permission-mode menu (accessible `role="menu"` / `menuitemradio`, keyboard operable). They list only what the runtime offers, and bypass only when the server sets `security.allowBypass`. Choosing bypass asks for confirmation and then shows a red banner. You can attach files with the + button, by drag and drop, or by pasting an image. Pending files show as chips (thumbnails for images), and sent ones appear in the user bubble. The mic button dictates via the Web Speech API: it is hidden where the API is unavailable, and its first use shows a privacy note. The "N running" chip lists active runs in every session and opens one. Settings apply from the next run. See [The composer](../../README.md#the-composer) for limits and the bypass warning.

Import `@uncage/react-ui/styles.css` once. Theme it with the `--uncage-*` CSS variables; every class uses the `uc-` prefix. `locale` is `'en'` (default) or `'zh-CN'`. Model output is rendered as inert markdown (no raw HTML).

API: [`src/index.ts`](./src/index.ts) (every export is documented with JSDoc) · Project overview: [README](../../README.md)
