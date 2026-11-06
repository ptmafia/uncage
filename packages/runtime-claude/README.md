# @uncage/runtime-claude

Runtime adapter for Claude Code, built on the Claude Agent SDK. `claudeAdapter()` runs each turn with the session's model, effort and permission mode (`default`, `acceptEdits`, `plan`, `auto`; `bypassPermissions` only with `allowBypass`). It turns every tool permission request Claude Code still asks for into an Uncage approval. Images are sent inline and other attached files are listed by path. The model list comes from `supportedModels()` and is cached for 10 minutes. It maps SDK messages to Uncage events and resumes the native session for multi-turn context. A Stop interrupts Claude Code and kills its child processes. Verified versions are listed in [docs/compatibility.md](../../docs/compatibility.md).

API: [`src/index.ts`](./src/index.ts) (every export is documented with JSDoc) · Project overview: [README](../../README.md)
