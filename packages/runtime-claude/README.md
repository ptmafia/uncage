# @uncage/runtime-claude

Runs Claude Code through the official Claude Agent SDK as an Uncage runtime: streaming text and tool events, approvals via `canUseTool`, session resume, model / effort / permission mode per session, and image/file attachments. Uses the Claude Code login on the machine.

```ts
import { claudeAdapter } from '@uncage/runtime-claude';
claudeAdapter({ allowBypass: false });
```

Prerequisite: `npm i -g @anthropic-ai/claude-code`, then `claude` → `/login`. Verified with Claude Code 2.1.318 / Agent SDK 0.3.318. `npx uncage serve` from `@uncage/cli` wires this up for you.

---

Part of **Uncage** — bring Claude Code (and Codex) into your own app with approvals, streaming and a ready-made UI. Start with [`@uncage/react-ui`](https://www.npmjs.com/package/@uncage/react-ui) for the 5-minute setup. MIT licensed.
