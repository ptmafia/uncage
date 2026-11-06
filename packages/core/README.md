# @uncage/core

Persistence and orchestration: `createUncage({ adapters, dataDir, workspace })` manages sessions, runs (at most one active per session), approvals with a TTL, and an append-only event log in PGlite. Embed it in your own Node process, or let `uncage serve` run it for you.

API: [`src/index.ts`](./src/index.ts) (every export is documented with JSDoc) · Project overview: [README](../../README.md)
