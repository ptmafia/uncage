# @uncage/runtime-acp

Runs any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP, stable v1) as an Uncage runtime: Uncage starts the agent's command, talks JSON-RPC to it over stdio with the official `@agentclientprotocol/sdk`, and maps its session updates to Uncage events (streaming messages, tool calls, plans, approvals, resume, cancel).

```ts
import { acpAdapter } from '@uncage/runtime-acp';

const adapter = acpAdapter({ id: 'acp-claude', displayName: 'Claude Code (ACP)', command: ['claude-agent-acp'] });
```

- One agent process per adapter, started on first use and shared by all sessions; it is restarted after it exits.
- Uncage declares no `fs/*` or `terminal/*` client capabilities: the agent uses its own tools on the workspace.
- Approvals offer allow once / deny. "Always" options are never selected, because an agent may store them outside the session.
- Thoughts, usage, commands and mode updates are not shown; a plan appears as one "Plan" step with a checklist.

**Status: experimental.** Verified with a fake ACP agent (in `@uncage/testkit`); see the compatibility matrix for real agents.

---

Part of **Uncage** — bring Claude Code (and Codex) into your own app with approvals, streaming and a ready-made UI. Start with [`@uncage/react-ui`](https://www.npmjs.com/package/@uncage/react-ui) for the 5-minute setup. MIT licensed.
