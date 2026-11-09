# @uncage/runtime-acp

Runs any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP, stable v1) as an Uncage runtime: Uncage starts the agent's command, talks JSON-RPC to it over stdio with the official `@agentclientprotocol/sdk`, and maps its session updates to Uncage events (streaming messages, tool calls, plans, approvals, resume, cancel).

```ts
import { acpAdapter } from '@uncage/runtime-acp';

const adapter = acpAdapter({ id: 'acp-claude', displayName: 'Claude Code (ACP)', command: ['claude-agent-acp'] });
```

- One agent process per adapter, started on first use and shared by all sessions; it is restarted after it exits.
- Uncage declares no `fs/*` or `terminal/*` client capabilities: the agent uses its own tools on the workspace.
- Approvals offer allow once / deny. "Always" options are never selected, because an agent may store them outside the session.
- Permission modes: `default` (ask), `acceptEdits` (edits, deletes and moves are allowed without asking) and, only with `allowBypass: true`, `bypassPermissions`. When the agent has a session mode with the same id, Uncage switches to it too.
- Site tools (connected mode) are served by a loopback MCP server for each run, with a bearer token, and passed to the agent in `mcpServers` as `site`: over HTTP when the agent supports it, otherwise through a small stdio bridge. Tools that need confirmation ask in Uncage before every call. `mcp: 'off'` turns site tools off.
- ACP has no skills: on every run the site's skills are written to `<cwd>/.uncage/skills/<name>/` (SKILL.md and files), and the first prompt of each new session includes them as text with the paths of those files (`skills: 'prompt'`). Inline shell forms in skill markdown are neutralized.
- If the agent cannot switch to the website's permission mode and would stay in a looser one, the run fails with `policy_denied`.
- Thoughts, usage, commands and mode updates are not shown; a plan appears as one "Plan" step with a checklist.

**Status:** verified live with Claude Code’s ACP adapter, `@agentclientprotocol/claude-agent-acp` 0.101.0 (streaming, approvals, site tools over HTTP MCP, `session/resume`, stop), and with a fake ACP agent (in `@uncage/testkit`) for the protocol contract. Gemini CLI and OpenCode are protocol-compatible but not verified live; see the [compatibility matrix](https://github.com/ptmafia/uncage/blob/main/docs/compatibility.md). Users configure agents in `runtimes.acp` of `~/.uncage/agent.yaml`: see [Use any ACP agent](https://uncage-dev.vercel.app/docs/guides/use-any-acp-agent/).

`pnpm --filter @uncage/runtime-acp smoke` drives the real Claude Code ACP adapter once outside the browser (spends a few tokens; needs a logged-in `claude` and `pnpm install` for the pinned adapter in `e2e/`).

---

Part of **Uncage** — bring Claude Code (and Codex) into your own app with approvals, streaming and a ready-made UI. Start with [`@uncage/react-ui`](https://www.npmjs.com/package/@uncage/react-ui) for the 5-minute setup. MIT licensed.

## Presets and the ACP registry

`resolveAcpAgents` turns `runtimes.acp` entries and the Claude Code / Gemini CLI / OpenCode presets
into adapter options. `buildAcpAgents` adds agents from the official
[ACP Registry](https://github.com/agentclientprotocol/registry): an agent installed on PATH (a binary
distribution for this OS, or a known npm bin) that answers the ACP `initialize` handshake is
enabled (results cached per path and file version; failures for 24 h, timeouts never). After a
registry refresh, a binary is handshaken only if its command equals the bundled snapshot's or the
one last handshaken. Registry binaries that are interpreters, shells or package runners, and
sensitive env vars (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PATH`, …), are refused. npx/uvx
distributions download code and are never run unless the user enables them; that consent is bound
to the runner and package name (`consented`). `autoDetect: false` turns detection and handshakes
off. On Windows, PATHEXT is honoured and npm `.cmd` shims run as `node <script>`. Agents run in
their own process group (POSIX) so stopping one stops what it started. A registry snapshot with the official icons (as data URIs)
is bundled (`pnpm registry:snapshot` refreshes it); `refreshRegistry` downloads a newer copy.
