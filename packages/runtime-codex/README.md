# @uncage/runtime-codex

Runtime adapter for Codex via `codex app-server` (stdio JSON-RPC). `codexAdapter({ command? })` maps app-server notifications to Uncage events and server approval requests to Uncage approvals. Status: implemented, and verified only against the fake app-server in this package. Real-binary flags such as `--stdio` are unverified. When `codex` is missing, `probe()` reports `not_installed` with the hint `npm i -g @openai/codex && codex login`.

API: [`src/index.ts`](./src/index.ts) (every export is documented with JSDoc) · Project overview: [README](../../README.md)
