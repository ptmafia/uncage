---
title: Use any ACP agent
description: 'Offer Gemini CLI, OpenCode, Claude Code’s ACP adapter or any other Agent Client Protocol agent next to Claude Code and Codex: runtimes.acp in ~/.uncage/agent.yaml, presets, the ACP registry, what differs from the native runtimes, troubleshooting and a checklist.'
---

The [Agent Client Protocol](https://agentclientprotocol.com) (ACP) is an open protocol between a client (an editor, or here Uncage) and a coding agent. The client starts the agent as a local process and talks JSON-RPC to it over stdin/stdout: it creates a session, sends prompts, and receives streamed messages, tool calls, plans and permission requests. Many agents speak it: Gemini CLI, OpenCode, Claude Code through its ACP adapter, and dozens more in the [ACP registry](https://github.com/agentclientprotocol/registry).

`@uncage/runtime-acp` turns every such agent into an Uncage runtime. Each one shows up in the website’s runtime picker as `<name> (ACP)`, with the runtime id `acp-<id>`, next to the native Claude Code and Codex runtimes. The agent runs on the user’s computer, in the session folder, with its own login: Uncage never sees its credentials.

This page is for the **user’s side** (the computer that runs `uncage agent`), like [local policy](/docs/guides/local-policy/). A website needs no change: it gets the new runtimes through the hub like any other.

## Configure

ACP agents are configured in `runtimes.acp` of `~/.uncage/agent.yaml`. With no `runtimes` key at all, the defaults apply: presets whose command is on PATH are registered, and installed agents from the ACP registry are detected. A complete example, with every field:

```yaml
runtimes:
  acp:
    presets: auto        # auto: register the presets whose command is on PATH; off: only what is listed below
    autoDetect: true     # detect installed agents from the ACP registry (handshake-checked); false: no detection
    enable: [gemini]     # registry agents you consented to run (written by `uncage runtimes enable`)
    consented:           # exactly what each `enable` consented to run (written by `uncage runtimes enable`)
      gemini:
        runner: npx
        package: "@google/gemini-cli"
        args: [--acp]
        env: {}
    disable: [opencode]  # registry, preset or runtime ids that are never registered
    agents:
      - id: claude                    # runtime id acp-claude
        preset: claude                # fill in the preset's name, command and install hint
      - id: mine                      # runtime id acp-mine
        displayName: My Agent         # shown in the runtime picker (default: the preset's name, else the id)
        command: [/usr/local/bin/my-agent, --acp]   # argv; command[0] is an absolute path or found on PATH
        env:                          # added to the agent's environment
          MY_AGENT_LOG: warn
        mcp: auto                     # site tools: auto (http if the agent supports it, else stdio), http, stdio, off
        enabled: true                 # false keeps the entry but does not register it
```

| Field | Default | |
| --- | --- | --- |
| `presets` | `auto` | `auto` registers each [preset](#presets) whose command is on PATH and that is not already listed in `agents`. `off`: none. |
| `autoDetect` | `true` | Detect installed agents from the ACP registry. An agent is enabled only if it answers the ACP `initialize` handshake (cached per path and file version). `false`: no detection and no handshakes. |
| `enable` | `[]` | Registry agents to run although they are not detected, for example agents that are downloaded with `npx` or `uvx`. Use `uncage runtimes enable <id>` rather than editing it. |
| `consented` | `{}` | Per id in `enable`: the runner (`local`, `npx`, `uvx`), the command or package (any version), `args` and `env` you agreed to. If the registry later runs something else, the agent waits for `uncage runtimes enable` again. |
| `disable` | `[]` | Never register these, whatever else says so (`uncage runtimes disable <id>`). |
| `agents` | `[]` | Agents you list yourself. They are always registered (if `enabled`). |
| `agents[].id` | required | Lowercase letters, digits and `-`. The runtime id is `acp-<id>`. Unique. |
| `agents[].preset` | | `claude`, `gemini` or `opencode`. An entry needs a `preset` or a `command`; its own fields win. |
| `agents[].displayName` | preset name, else the id | At most 60 characters. |
| `agents[].command` | the preset’s | The argv, without a shell. |
| `agents[].env` | | Extra environment variables. |
| `agents[].mcp` | `auto` | How [site tools](/docs/guides/define-tools/) reach the agent; `off` turns them off for this agent. |
| `agents[].enabled` | `true` | |

The agent reads `agent.yaml` when it starts: restart it after a change (see [apply a change](/docs/guides/local-policy/#apply-a-change)). `uncage setup` and `uncage sites remove` keep `runtimes` and your comments.

To see what this computer offers, run `uncage runtimes`:

```text
ID          NAME               STATUS         VERSION  SITE TOOLS  RESUME
claude      Claude Code        available      2.1.318  yes         yes
codex       Codex              not installed  -        no          yes
acp-claude  Claude Code (ACP)  available      0.101.0  yes         yes
```

It also lists registry agents that are not registered and how to turn them on. `--json` prints the same as JSON, `--all` adds the registry agents that are not installed, and `--refresh` downloads the latest registry first.

### Agents from the ACP registry

A snapshot of the official ACP registry (names, commands, icons) ships with Uncage; the agent refreshes it at most once a day in the background (`UNCAGE_ACP_REGISTRY_REFRESH=0` turns that off). Nothing from the registry runs without a check:

- An agent installed on this computer (a binary for this OS, or a known npm bin on PATH) is enabled only after it answers the ACP handshake. After a registry refresh, a changed command waits for `uncage runtimes enable`.
- An agent distributed through `npx` or `uvx` downloads code, so it never runs until you run `uncage runtimes enable <id>`. That records what you agreed to in `consented`.

```sh
uncage runtimes enable gemini    # consent: prints exactly what will run, then registers it
uncage runtimes disable gemini   # never register it
```

In Local Mode (`uncage serve`), `uncage.config.yaml` accepts the same `runtimes.acp` block, except that `enable` and `consented` are ignored there: a project file cannot consent to running downloaded agents. `uncage doctor` and `uncage serve` print the command of every ACP agent the project file adds.

## Presets

| Preset | Runtime | Command | Install | Status |
| --- | --- | --- | --- | --- |
| `claude` | Claude Code (ACP) | `claude-agent-acp` | `npm i -g @agentclientprotocol/claude-agent-acp` (uses your Claude Code login) | **Verified live** with `@agentclientprotocol/claude-agent-acp` 0.101.0 (2026-11-08): streaming, approvals, site tools, resume, stop |
| `gemini` | Gemini CLI (ACP) | `gemini --acp` | `npm i -g @google/gemini-cli` | Protocol-compatible, not verified live |
| `opencode` | OpenCode (ACP) | `opencode acp` | `npm i -g opencode-ai` | Protocol-compatible, not verified live |

The commands match the ACP registry’s entries. The native Claude Code runtime stays the recommended way to run Claude Code (it has models, effort, `plan` and `auto`); the `claude` preset is useful to compare, or where only the ACP adapter is available. The current results are in the [compatibility matrix](https://github.com/ptmafia/uncage/blob/main/docs/compatibility.md).

## Differences from the native runtimes

| | Native Claude Code | ACP agents |
| --- | --- | --- |
| Skills | Installed as Claude Code skills (`.claude/skills/`) | No skills in ACP: written to `.uncage/skills/<name>/` in the session folder, and the first prompt of each new session lists them as text with those paths (`skills: 'prompt'`) |
| Files and commands | Claude Code’s own tools | The agent’s own tools in the session folder. Uncage offers no ACP `fs` or `terminal` client capabilities |
| Approvals | Allow once / deny | Allow once / deny. Uncage answers with the agent’s `allow_once` or `reject_once` option and never picks an “always” option (the agent could store it outside the session) |
| Permission modes | `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions` | `default`, `acceptEdits`, and `bypassPermissions` only with `localPolicy.allowBypass`. Uncage enforces them itself and also switches the agent to a mode with the same id if it has one |
| Models and effort | From Claude Code | Not offered (the agent’s own default) |
| Thinking, usage, slash commands | Thinking is not shown | Not shown |
| Plans | — | One “Plan” step whose output is a checklist |
| Site tools | In-process MCP server | A loopback MCP server for each run, with a one-time bearer token, passed to the agent in `mcpServers` as `site` (over HTTP when the agent supports it, otherwise through a small stdio bridge). Tools with `requiresConfirmation` ask in Uncage before every call |
| Resume | Always | Only if the agent supports `session/resume` or `session/load`. Otherwise the next message starts a new conversation, with an `acp_resume_unsupported` warning |
| Attachments | Images and files | Images if the agent accepts them; other files as links to their path |

One agent process per runtime is started on first use and shared by every session; it is restarted if it exits. Stop sends `session/cancel` and, if the agent has not stopped within 10 seconds, ends its process group.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The runtime shows `not_installed` (“not installed”) | The command is not on PATH. Install the agent (the hint shows how) or put an absolute path in `command`, then restart the agent. |
| A run fails with `auth_required` | The agent needs its own login. Sign in with the agent itself in a terminal (for example run `claude` and `/login`, or `gemini`), then retry. Uncage never handles the agent’s credentials. |
| “The agent did not answer initialize within 15000 ms” | The command started but does not speak ACP (a wrong flag, an old version, or a prompt waiting for input). Run the command by hand: it should wait silently for JSON on stdin. |
| A registry agent shows `available`, not registered | It is distributed with `npx`/`uvx`, or its command changed after a registry refresh. Run `uncage runtimes enable <id>` if you want it. |
| The runtime is missing | Check `uncage runtimes` (and `uncage runtimes --all`): it may be disabled, `enabled: false`, or `presets: off`. `uncage doctor` shows one `runtime.acp-<id>` row per ACP agent; these rows never fail the check. |
| A site tool is not called | `mcp: off` on that agent, or the agent does not support MCP servers. Set `mcp: stdio` to try the stdio bridge. |
| The run fails with `policy_denied` when the mode changes | The agent could not switch to the website’s permission mode and would stay in a looser one. |

## Verify

1. `uncage runtimes` lists the agent as `available`, with its version, and `SITE TOOLS yes` unless you set `mcp: off`.
2. `uncage doctor` shows `✓ Runtime acp-<id>`.
3. On the website, the runtime picker lists `<name> (ACP)`; pick it and send a prompt: the answer streams in.
4. Ask for a file change in `default` mode: an approval card appears; **Allow once** applies it.
5. Ask it to use a site tool that requires confirmation: exactly one approval card appears, and the tool runs on the website after you allow it.
6. Send a follow-up in the same session: the agent remembers the conversation (if `RESUME` is `yes`).
7. Start a long command and press Stop: the run is cancelled within a few seconds.
