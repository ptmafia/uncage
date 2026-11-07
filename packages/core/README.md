# @uncage/core

The embeddable engine behind `uncage serve`: `createUncage({ adapters, dataDir, workspace, approvals, security })` manages sessions, runs (one active per session), approvals with a TTL and single-winner decisions, per-session settings, attachments, and an append-only event log with replay, persisted in PGlite.

```ts
import { createUncage } from '@uncage/core';
import { claudeAdapter } from '@uncage/runtime-claude';

const uncage = await createUncage({ adapters: [claudeAdapter()], workspace: { default: process.cwd() } });
const session = await uncage.sessions.create({ runtime: 'claude' });
await session.startRun({ prompt: 'Summarize this repo' });
for await (const e of session.events({ after: 0 })) console.log(e.type);
```

One process per data directory. To serve it over HTTP use `@uncage/server`, or just `npx uncage serve` from `@uncage/cli`.

---

Part of **Uncage** — bring Claude Code (and Codex) into your own app with approvals, streaming and a ready-made UI. Start with [`@uncage/react-ui`](https://www.npmjs.com/package/@uncage/react-ui) for the 5-minute setup. MIT licensed.
