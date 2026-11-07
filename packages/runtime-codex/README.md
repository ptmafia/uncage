# @uncage/runtime-codex

Runs OpenAI Codex as an Uncage runtime by driving `codex app-server` over stdio JSON-RPC (approvals, streaming, resume, model/effort, image attachments).

**Status: experimental.** Implemented against the official app-server schema and verified only with a fake app-server, not a real `codex` binary yet. If `codex` isn't installed, Uncage shows it as "not installed" with `npm i -g @openai/codex && codex login`.

---

Part of **Uncage** — bring Claude Code (and Codex) into your own app with approvals, streaming and a ready-made UI. Start with [`@uncage/react-ui`](https://www.npmjs.com/package/@uncage/react-ui) for the 5-minute setup. MIT licensed.
