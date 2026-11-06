# @uncage/runtime-claude

Runtime adapter for Claude Code, built on the Claude Agent SDK. `claudeAdapter()` runs with `permissionMode: 'default'` and turns each tool permission request into an Uncage approval. It maps SDK messages to Uncage events and resumes the native session for multi-turn context. A Stop interrupts Claude Code and kills its child processes. Verified versions are listed in [docs/compatibility.md](../../docs/compatibility.md).

API: [`src/index.ts`](./src/index.ts) (every export is documented with JSDoc) · Project overview: [README](../../README.md)
