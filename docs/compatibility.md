# Runtime compatibility

These are the versions each adapter has been verified against. Live checks run on macOS (darwin-arm64).

| Runtime | Adapter | SDK / CLI version | Verified | Status |
| --- | --- | --- | --- | --- |
| Claude Code | `@uncage/runtime-claude` | `@anthropic-ai/claude-agent-sdk` 0.3.318 (bundled CLI 2.1.318); `claude` CLI on PATH 2.1.318 | 2026-11-07 | **Live E2E passed** (20/20 on the latest run; see the run records below). The composer specs cover model, effort, the permission modes (including bypass), image and file attachments via the + button, and the running chip. Drag and drop and paste are covered by the mock E2E only. Voice is [pending manual verification](#voice-input-pending-manual-verification-by-the-user-requires-microphone). A `resume` of a session Claude Code no longer has was checked live: it yields `native.session_lost` (the session becomes read-only). Live smoke passed earlier: one approval request (Write, auto-allowed), `tool.completed`, `run.completed`, `hello.txt` created. |
| Codex | `@uncage/runtime-codex` | none (not installed on the test machine) | 2026-11-06 (mock only) | **Implemented, verified only against a fake app-server** (`@uncage/testkit` fake codex). Protocol facts were checked against the official `openai/codex` app-server-protocol schema and two third-party clients. Unverified against a real binary: whether `codex app-server` needs `--stdio` (one client passes it), and real-binary process and auth behavior. When it isn't installed, the UI and `uncage doctor` show `not_installed` with `npm i -g @openai/codex && codex login`. This is asserted live. |
| Claude Code over ACP | `@uncage/runtime-acp` | `@agentclientprotocol/claude-agent-acp` 0.101.0 (ACP v1, `@agentclientprotocol/sdk` 2.4.0, Claude Agent SDK 0.3.318); `claude` CLI 2.1.318 | 2026-11-08 | **Live E2E passed** (`connected-acp-live`, 2/2) and live smoke passed (`pnpm --filter @uncage/runtime-acp smoke`, 10/10 checks). Streaming, approval cards (once/deny), site tools over the per-run HTTP MCP server, exactly one card for a confirmation tool, publish, history after reload, `session/resume` with the re-declared MCP server, Stop → `cancelled` in < 1 s. See [ACP agents](#acp-agents-claude-code-via-claude-agent-acp) |
| Gemini CLI over ACP | `@uncage/runtime-acp` (preset `gemini`: `gemini --acp`) | `@google/gemini-cli` (registry: 0.67.0) | — | **Protocol-compatible, not verified live.** The command matches the ACP registry entry. Not run. |
| OpenCode over ACP | `@uncage/runtime-acp` (preset `opencode`: `opencode acp`) | `opencode-ai` (registry binary) | — | **Protocol-compatible, not verified live.** The command matches the ACP registry entry. Not run. |
| Fake ACP agent | `@uncage/runtime-acp` | `@uncage/testkit` fake ACP agent (stdio, ACP v1) | 2026-11-08 | **Contract suite passes** (`pnpm --filter @uncage/runtime-acp test`): the adapter contract, approvals, site tools over HTTP and the stdio bridge, resume/load, cancel ordering, crashes, process groups. |

## Live E2E run record

`UNCAGE_LIVE=1 pnpm e2e:live`, 2026-11-06: 7 passed in 1.2 min, in two consecutive full runs.

- Environment: macOS 26.6.2 (arm64), Node 24.15.0, pnpm 10.33.0, Playwright 1.65.0, Google Chrome 157.0.8103.39 (system, `channel: 'chrome'`, headless), Next.js 16.4.5, Claude Code CLI 2.1.318, Claude Agent SDK 0.3.318. Codex was not installed.
- Stack: the real CLI `node packages/cli/dist/bin.js serve --workspace <tmp copy of e2e/live/fixture-repo> --data-dir <tmp> --token-file <tmp>` and `examples/nextjs-default-chat` (`next start`), with the token passed to its proxy as `UNCAGE_TOKEN`. The user's `~/.uncage` is not touched.

| # | Spec | Result |
| --- | --- | --- |
| 1 | The runtime selector shows Claude Code available (selected) and Codex `未安装` with the npm hint (disabled) | ✓ |
| 2 | "扫描这个仓库的结构，然后运行 npm test": an approval card shows the `npm test` command, Allow, ≥1 completed tool step, run `completed` | ✓ 15 s |
| 3 | "在根目录创建 deny-me.txt": Deny every card (the card shows the path). The run is `completed`, the line reads "你拒绝了", the step is marked declined, and `deny-me.txt` does not exist | ✓ 14 s |
| 4 | Bash `npm run wait61` (runs `sleep 61`): Allow, check that `sleep 61` is running, Stop. Run `cancelled` within 10 s, and `pgrep -f "sleep 61"` is empty within 10 s | ✓ 4 s |
| 5 | Bash `npm run wait21`: Allow, reload mid-run. One user bubble, one resolved line per approval (not duplicated), run finishes `completed` | ✓ 27 s |
| 6 | "记住数字 42", then a new run "我让你记住的数字是多少？": the answer contains "42" (native session resumed) | ✓ 5 s |
| 7 | `curl` the daemon without a token → 401; with the token and `Origin: http://evil.test` → 403; the app proxy with a foreign Origin → 403 | ✓ |

The HTML report, traces and the stack log are written to `e2e/live/results/`, which is gitignored.

### Run 2: final-review fixes

`UNCAGE_LIVE=1 pnpm e2e:live`, 2026-11-06: 10 passed in 1.8 min.

- Environment: same as above (macOS 26.6.2 arm64, Node 24.15.0, pnpm 10.33.0, Playwright 1.65.0, Google Chrome 157.0.8103.39, Next.js 16.4.5, Claude Code CLI 2.1.318, Claude Agent SDK 0.3.318). Codex not installed.
- Stack: as above, plus `examples/react-headless-chat` (`next start`) on a second port with the same token.
- Specs 1–7 as above passed again (2: 19 s, 3: 14 s, 4: 5 s, 5: 28 s, 6: 6 s). New specs:

| # | Spec | Result |
| --- | --- | --- |
| 8 | Bash `npm test`: reload (F5) while the approval is **pending**. After the reload the card is still pending and shows the command, the run is `waiting_approval`, one user bubble. Allow → run `completed`, line `approved` | ✓ 14 s |
| 9 | Two tabs on the same live session both click Allow (requests held until both are sent, so they race at the daemon): statuses `[200, 409]`, both tabs show the approval `approved` and the run `completed`, no error toast | ✓ 6 s |
| 10 | Golden path through `examples/react-headless-chat`: prompt → approval card with `npm test` → Allow → run `completed` | ✓ 14 s |

Also checked live, outside Playwright: `query({ resume: '00000000-0000-0000-0000-000000000000' })` returns a `result` message with `subtype: 'error_during_execution'`, `num_turns: 0` and `errors: ['No conversation found with session ID: …']`, then the iterator throws `Claude Code returned an error result: No conversation found …`. The Claude adapter turns that into `native.session_lost` (fixture: `packages/runtime-claude/src/fixtures/resume-missing.json`).

### Claude Code behaviors observed live (2.1.318)

- **Some commands never reach the approval layer.** In `permissionMode: 'default'`, Claude Code auto-allows what it classifies as safe, without calling `canUseTool`. That includes reads and searches, and also a bare `sleep 60`. Uncage cannot show a card for these. It does show them as tool steps.
- **Long foreground `sleep` is blocked by Claude Code's Bash tool.** Claude Code tells the model to use `run_in_background` or Monitor instead. Without instructions, the model may also choose to background a long command. The live spec therefore wraps the sleeps in npm scripts (`npm run wait61` / `wait21`) and asks for a foreground run.
- **Stop kills the process tree.** After Stop, the `npm` → `sh` → `sleep` children of the Bash tool are gone within seconds.
- **Watch out on dev machines:** other software can run its own `sleep 60` loop (seen here: a VPN client), and `pgrep -f "sleep 60"` matches it too. That's why the spec uses `sleep 61` / `sleep 21`.

## Composer: session settings and attachments (Claude Code)

`pnpm --filter @uncage/runtime-claude smoke [flags]`, 2026-11-07. Environment: macOS 26.6.2 (arm64), Node 24.15.0, Claude Code CLI 2.1.318, Claude Agent SDK 0.3.318. All checks passed.

| Run | Checks | Result |
| --- | --- | --- |
| every run | `refreshCapabilities()` opens a streaming-input `query()` that never sends a turn, calls `supportedModels()`, then `interrupt()` + abort. It returned 13 models in about 0.4 s, starting with `default` (`Default (recommended)`, resolves to `claude-fable-5-1`), then `opus`, `fable`, `sonnet`, `haiku` and pinned ids | ✓ |
| `--image e2e/fixtures/uncage-42.png` | The PNG goes in as one SDK user message (base64 image block + text). The answer was exactly `UNCAGE-42` | ✓ |
| (same, second run) | `resume` of that session with streaming input again, carrying an attached `.md` file listed by path. Claude read the file with `Read` and answered `UNCAGE-42 ZEBRA-9`, so it remembered the image from the resumed session and read the file | ✓ |
| `--permission-mode acceptEdits --model haiku --effort low` | The Write tool ran with **no** approval request. `hello.txt` was created and the run `completed`. The init message showed `model: claude-haiku-5-5`, `permissionMode: acceptEdits` | ✓ |
| (no flags) | V0 regression in `default` mode: exactly one approval request (Write), `hello.txt` created, `run.completed` | ✓ |

- `e2e/fixtures/uncage-42.png` (610×150, grayscale) is generated by `node e2e/scripts/make-uncage-42.ts`, which uses a 5×7 bitmap font and a minimal PNG encoder (`node:zlib`). Nothing is downloaded.
- Claude reports `attachments.maxImageBytes: 5 MB` (the Anthropic API's per-image limit). Core rejects larger images at upload with `attachment_too_large`. The model probe runs with `settingSources: []`, so no project hooks run. After a failed probe it waits 60 s before trying again.
- `bypassPermissions` is passed to Claude Code (with `allowDangerouslySkipPermissions: true`) only when the server runs with `security.allowBypass`. Otherwise the adapter refuses the run with `policy_denied`, as a second check after core. The smoke script didn't run it. Run 3 below covers it live.

### Run 3: composer controls (live E2E)

`UNCAGE_LIVE=1 pnpm e2e:live`, 2026-11-07: **20 passed in 3.1 min** (the 10 specs of runs 1–2 plus 10 composer specs). The 10 composer specs had also passed on their own just before, 10/10 in 1.4 min.

- Environment: macOS 26.6.2 (arm64), Node 24.15.0, pnpm 10.33.0, Playwright 1.65.0, Google Chrome 157.0.8103.39 (system, headless), Next.js 16.4.5, Claude Code CLI 2.1.318, Claude Agent SDK 0.3.318. Codex not installed.
- Stack: as in run 2. In addition, a second `uncage serve` runs with `UNCAGE_ALLOW_BYPASS=1` on its own tmp copy of the fixture repo, with its own data dir and token file, and `nextjs-default-chat` sits in front of it. The main server is started with `UNCAGE_ALLOW_BYPASS` cleared.
- Each composer spec starts a new session in `nextjs-default-chat`. It checks the UI state and the server's session snapshot (`GET /v1/sessions/:id`). It checks model text only where noted.

| # | Spec | Result |
| --- | --- | --- |
| 11 | Model: the runtime reports `modelsAuthoritative: true`, and the menu lists exactly the `supportedModels()` labels. That was 13 models: `default`, `opus`, `fable`, `sonnet`, `haiku` and 8 pinned ids. The spec picked `haiku`; it was stored in the session settings and the run was `completed` | ✓ 2 s |
| 12 | Effort `低` (`low`): stored, run `completed` | ✓ 3 s |
| 13 | `acceptEdits` ("Use your Write tool to create a.txt … hello"): **no** approval card, run `completed`, `a.txt` contains `hello`. The menu has no bypass entry on this server | ✓ 5 s |
| 14 | `plan`, same prompt: run `completed`, `a.txt` **not** created. Claude asked to leave plan mode with an `ExitPlanMode` approval card. The spec denied it (in the standalone run Claude then also asked an `AskUserQuestion`, also denied) | ✓ 20 s |
| 15 | `default` regression: Bash `npm test` shows an approval card with the command. Allow → `completed` | ✓ 14 s |
| 16 | Image `uncage-42.png` + "What text is in the image?": the thumbnail is in the user bubble, and the answer contains `UNCAGE-42` (model text) | ✓ 3 s |
| 17 | File `notes.md` (contains "the secret word is marmalade"; first removed from the workspace, so the attachment is the only copy) + "What is the secret word in the attached file?". Every approval card is denied, and none appeared. The file chip is in the bubble, and the answer contains `marmalade` (model text) | ✓ 4 s |
| 18 | `auto`: run **`completed`** (no `unsupported_capability`). Claude Code 2.1.318 accepts `permissionMode: 'auto'` | ✓ 3 s |
| 19 | Running chip: a run waits for approval in session A. After "新建会话" the chip reads `1 个运行中`. Choosing it from the chip's menu opens session A with its pending card. Allow → `completed`, and the chip disappears | ✓ 14 s |
| 20 | Bypass (allowBypass server): the menu offers `完全放行`, and choosing it opens the confirm dialog. After `开启`, "用 Bash 工具运行 `echo bypass-ok > bypass.txt`": **no** approval card, run `completed`, the red bypass banner is visible, `bypass.txt` contains `bypass-ok` (in the bypass server's tmp workspace), and the session stores `bypassPermissions` | ✓ 5 s |

- The mock E2E (`pnpm e2e:mock`, `e2e/mock/composer.spec.ts`) covers the same controls against the fake runtime. Its `echo` prompt replies with the settings and attachment names the adapter received. It also covers drag and drop, paste (a file-only clipboard attaches, a clipboard with text pastes text), reload, the 11-file count rejection, bypass being absent without `allowBypass`, and the mic button with an injected fake `SpeechRecognition`.
- Attachment order: a run receives its attachments in the order they were picked (the `attachmentIds` order), whichever upload finished first. The same order is stored with the run, so bubbles keep it after a reload.

### Voice input: pending manual verification by the user (requires microphone)

Dictation uses the browser's Web Speech API, which needs a real microphone and the browser vendor's speech service, so it **has not been verified live**. Only the UI is tested automatically, with a fake recognizer in the mock E2E. To check it by hand in Google Chrome:

1. `pnpm build`, then `pnpm uncage serve` in a project folder, and in another terminal `pnpm --dir examples/nextjs-default-chat start` (with `UNCAGE_TOKEN` if serve used `--token-file`).
2. Open `http://localhost:3000` in Chrome (desktop). The mic button (语音输入) is right of the toolbar, next to Send.
3. Click the mic. The first time, a note appears under the composer: "语音由浏览器厂商的语音服务处理。". Allow microphone access when Chrome asks.
4. Say a short sentence, e.g. "列出这个仓库的文件". Interim text should appear in the prompt box and settle into the final text. The button shows a pulsing ring while listening.
5. Click the mic again to stop. The ring goes away, the text stays and can be edited, and Enter sends it.
6. Block the microphone (site settings) and click the mic: the composer shows "麦克风权限被拦截了，请在浏览器里允许后再试。".

Record the result (Chrome version, ✓/✗ per step) here.

## Connected mode: site tools and skills (Claude Code)

`pnpm --filter @uncage/runtime-claude smoke -- --site`, 2026-11-07. Environment: macOS 26.6.2 (arm64), Node 24.15.0, Claude Code CLI 2.1.318, Claude Agent SDK 0.3.318, model `claude-fable-5-1`. All checks passed in `default`, `bypassPermissions` and `auto` mode.

- Site tools run as an in-process MCP server named `site` (`createSdkMcpServer`, `alwaysLoad: true`); Claude Code sees them as `mcp__site__<name>`. Each tool's JSON Schema is converted with zod 4 `z.fromJSONSchema`, and the MCP server validates arguments against it. A schema gets a permissive object schema instead, and the hub validates those arguments, if it uses `$ref`/`$defs` (zod's synchronous conversion can blow up exponentially on them), has more than 2000 nodes, isn't an object schema, or can't be converted by zod. The first two cases are checked before zod sees the schema.
- `echo_text` (`requiresConfirmation: false`) is allowed by the adapter's `canUseTool`, not by `allowedTools`, so the SDK's `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning doesn't appear. Claude called it without an approval card, got `ECHO-7731: hello uncage` back, and quoted it in the answer.
- `stamp_note` (`requiresConfirmation: true`) raised exactly one approval: category `mcp`, title = the tool description, `target.command` = `stamp_note({"note":"smoke"})`. The smoke auto-allowed it. Its `json` result (`STAMP-5150`) showed up in the answer. Confirmation tools get `permission_policy: 'always_ask'` and the annotation `destructiveHint: true`. The approval was requested **even under `bypassPermissions`**, and in `auto` mode too, because the classifier doesn't auto-approve destructive tools.
- A skill (`<cwd>/.claude/skills/kumquat-signoff/SKILL.md`, rule "always end every answer with KUMQUAT") was found and loaded through the `Skill` tool (no approval requested), and the answer ended with KUMQUAT. When a run carries skills, the adapter adds `'project'` to `settingSources`.
- Codex: `siteTools: false`. Codex has no site-tool support yet, so core refuses a manifest with tools for a Codex session (`unsupported_capability`).

## Connected mode end to end: the connected-demo website (Claude Code)

`examples/connected-demo` is a website with the hub mounted in its own Node server. It offers two site tools: `create_asset`, and `publish_asset` (needs confirmation, pulls files with `ctx.files.pull`). It also has a `landing-page` skill and `sessionStorage: 'site'`. The specs in `e2e/connected/` drive it in system Chrome, all through the same golden path (`golden-path.ts`):

1. Sign in. The chat shows `ConnectMachine` with `uncage setup <url>`.
2. The **real** CLI runs `uncage setup <url> --no-daemon --no-browser`. Playwright opens the printed `/device?code=…` link in a second tab, checks `X-Frame-Options: DENY` and `frame-ancestors 'none'` and that the code matches, then clicks 批准. Setup exits 0.
3. The agent starts and the header shows `电脑：<name>（在线）`.
4. The spec sends "做一个介绍 Uncage 的落地页并发布" and allows every approval card until the run ends. The run must be `completed`, and one card must be `publish_asset`.
5. `/assets` lists the asset as 已发布. Its page links back to the run's session, shows `<iframe sandbox="allow-scripts">`, and an `<h1>` renders inside it. `/asset-files/…` is served with `sandbox allow-scripts` + `default-src 'none'`. The mock also checks that the page's own `css/app.css` loads (the CSP allows the path-scoped `<origin>/asset-files/<id>/` source and `connect-src 'none'`).
6. Reload: the conversation is shown.
7. The agent is stopped and the page reloaded: the conversation is still shown (site replica), the composer reads "你的电脑离线了，等待重新连接…" and is disabled.

The agents run with `UNCAGE_HOME=<tmp>` (new in `@uncage/cli`: it moves `~/.uncage` and `~/Uncage`) and the real `HOME`, so Claude Code keeps its login and the user's `~/.uncage` is never touched. A tmp `HOME` does not work on macOS: Claude Code then reports "Not logged in", because its login is found through `HOME` (Keychain / `~/.claude.json`). Setting `CLAUDE_CONFIG_DIR` breaks its config lookup.

Run record, 2026-11-07. Environment: macOS 26.6.2 (arm64), Node 24.15.0, pnpm 10.33.0, Playwright 1.65.0, Google Chrome 157.0.8103.39 (system, headless), Next.js 16.4.5, Claude Code CLI 2.1.318, Claude Agent SDK 0.3.318, Docker with `redis:7-alpine` and `postgres:16-alpine`.

| Project | Stack | Result |
| --- | --- | --- |
| `connected-mock` (in `pnpm e2e:mock`) | Demo on one node (PGlite + memory cluster), real `uncage setup`, the real `@uncage/agent` with the testkit fake runtime (`e2e/connected/fake-agent.ts`: writes `landing/index.html`, then calls `create_asset`, raises a `publish_asset` card, and calls `publish_asset` with the `assetId` it got back) | ✓ 22 s, plus a second spec ✓: a cross-site sign-in POST gets 403, `/device` with an unknown code offers no 批准, and another user sees no assets |
| `connected-multinode` (`UNCAGE_DOCKER_TESTS=1`) | `scripts/multinode.ts` runs `HUB_NODES=2` on throwaway Redis + Postgres containers behind the round-robin proxy. Four consecutive `/machines` requests all show the machine online, and their `x-upstream-node` headers show both nodes answered. Same golden path | ✓ 23 s (containers removed afterwards) |
| `connected-live` (`UNCAGE_LIVE=1`, in `pnpm e2e:live`) | Real `uncage agent` with Claude Code (default permission mode) | ✓ 1.8 min. The full `UNCAGE_LIVE=1 pnpm e2e:live` passed 21/21 in 4.8 min (the 20 Local Mode specs above + this one). Passed again (1.8 min) after the polish follow-up |

Observed live (Claude Code 2.1.318, default model). Claude Code called `create_asset` with no card (a tool without confirmation). In the full run it then raised cards for its own Bash (`ls`/`find` to look at the workspace), WebSearch (about Uncage) and Write (`landing/index.html`). Last came the `publish_asset` card: `publish_asset({"assetId":"a_…","dir":"landing"})`, with the id `create_asset` had returned. After Allow the site stored the single `index.html`. It was an inline-CSS dark landing page with one `<h1>` ("打开笼子，让 AI 真正动手做事") and no external resources, and it rendered in the sandboxed iframe. On the first standalone run the cards were WebSearch, Write and `publish_asset`. The exact steps vary between runs; the spec allows every card. Screenshots and process logs go to `e2e/connected/results/` (gitignored).

## ACP agents: Claude Code via claude-agent-acp

`@uncage/runtime-acp` drives Claude Code's ACP adapter, `@agentclientprotocol/claude-agent-acp` **0.101.0**, pinned as a devDependency of `e2e/` and started as `node <pkg>/dist/index.js`. It uses the Claude Code login under the real `HOME`. Environment for both runs below: macOS 26.6.2 (arm64), Node 24.15.0, pnpm 10.33.0, Playwright 1.65.0, Google Chrome (system, headless), Claude Code CLI 2.1.318. Only this adapter ran: no other ACP agent, no npx/uvx registry agent, `UNCAGE_HOME` a fresh tmp dir.

**Observed `initialize` (2026-11-08):** `protocolVersion: 1`, `agentInfo: { name: '@agentclientprotocol/claude-agent-acp', title: 'Claude Agent', version: '0.101.0' }`, `authMethods: []` (already signed in), and

```json
{
  "_meta": { "claudeCode": { "promptQueueing": true }, "authStatus": {} },
  "promptCapabilities": { "image": true, "embeddedContext": true },
  "mcpCapabilities": { "http": true, "sse": true },
  "auth": { "logout": {} },
  "providers": {},
  "loadSession": true,
  "sessionCapabilities": { "additionalDirectories": {}, "close": {}, "delete": {}, "fork": {}, "list": {}, "resume": {}, "systemPrompt": { "mode": { "override": {} } } }
}
```

Uncage maps that to `nativeResume: true`, `siteTools: true`, `attachments.images: true`, `skills: 'prompt'`, `approval: { once: true, session: false }`, `permissionModes: ['default', 'acceptEdits']`, `models: [default]`. `initialize` took 173 ms.

### Smoke (`pnpm --filter @uncage/runtime-acp smoke`), 2026-11-08: 10/10 checks, 11.6 s

| Step | Result |
| --- | --- |
| `session/new` with the site MCP server declared as `{ type: 'http', name: 'site', url: 'http://127.0.0.1:<port>/mcp', headers: [Authorization: Bearer …] }` (the agent has `mcpCapabilities.http`), then `session/set_mode default` | ✓ |
| "Create hello.txt …, then call stamp_note": exactly **one native approval** (`Write hello.txt`, kind `edit`, category `file`), auto-allowed; `hello.txt` created | ✓ |
| `stamp_note` (`requiresConfirmation: true`): exactly **one site approval** (category `mcp`, title = the tool description, `stamp_note({"note":"smoke"})`), from the site MCP handler. The agent's own `session/request_permission` for the same call was auto-allowed by the site-tool rule, so no second card. The result `STAMP-5150` was in the answer. Run 6.6 s | ✓ |
| Second run with the native session ref: **`session/resume`** (the adapter prefers it over `session/load`) with the site MCP server **declared again** on a new port and token. The agent remembered `STAMP-5150` and called `echo_text` on the re-declared server (`ECHO-7731: again`). Run 4.5 s | ✓ |
| Streaming: 29 `agent_message_chunk` updates over the two runs | ✓ |

**How claude-agent-acp names MCP tool calls** (this is what the site-tool auto-allow matches): both the `tool_call` update and the `session/request_permission` tool call carry `name: "mcp__site__<tool>"` and `title: "mcp__site__<tool>"`, `kind: "other"`, and `_meta.claudeCode.toolName: "mcp__site__<tool>"`; the permission request adds `_meta.claudeCode.mcpServer: { name: "site", source: "dynamic" }`. The agent asks permission for **every** MCP tool, including ones without `requiresConfirmation` (`echo_text`); Uncage's exact `mcp__site__<name>` match allows those without a card. Claude Code first calls its own `ToolSearch` tool (`Tool: mcp__site__stamp_note`) to load the deferred MCP tool; it needs no approval. Native tools look like `name: "Write"`, `title: "Write hello.txt"` (the first `tool_call` title is "Preparing file…"), `kind: "edit"`.

Other updates seen: `available_commands_update`, `config_option_update`, `usage_update`, `session_info_update` (all dropped by Uncage), and the agent's own `_auth/status_update` notification (an extension; ignored).

### Live E2E (`connected-acp-live`), 2026-11-08: 2/2 passed in 1.7 min (twice)

`agent.yaml` gets `runtimes.acp = { presets: 'off', autoDetect: false, agents: [{ id: 'claude', preset: 'claude', command: [node, <pkg>/dist/index.js] }] }`, the real `uncage agent` runs with `UNCAGE_ACP_REGISTRY_REFRESH=0`, and the website shows `Claude Code (ACP) 0.101.0` in the runtime picker next to the native runtimes.

| # | Spec | Result |
| --- | --- | --- |
| 1 | Golden path on the connected demo: connect (real `uncage setup` + /device) → pick **Claude Code (ACP)** → "做一个介绍 Uncage 的落地页并发布" → streaming → cards: `Write landing/index.html` (Claude Code's own write) and exactly **one** `publish_asset({"assetId":"a_…","dir":"landing"})` card (the site MCP handler's); `create_asset` ran without a card → run `completed` → the asset is published and renders an `<h1>` in the sandboxed iframe → reload shows the history, the session header shows the ACP runtime → agent stopped, history still there | ✓ 1.2 min, and 1.3 min on the final run (the run itself: about 65 s) |
| 2 | Stop: Bash `python3 -c "import time; time.sleep(61.5)"` → approval card → Allow → the process is running → Stop → run `cancelled` in 58 ms, the python process gone 76 ms after Stop (final run: 65 ms / 82 ms) | ✓ 13 s |

### Notes

- Permission options (from the adapter's source, `dist/permissions/options/`): `allow-once` ("Yes", `allow_once`), `reject` ("No", `reject_once`) and, for many tools, an `allow_always` option that adds a rule to Claude Code's **local settings** (outside the session). This confirms the design: Uncage only ever picks `allow_once` / `reject_once`.
- No `agent_thought_chunk` arrived in these runs (the adapter can send them; Uncage drops them). `usage_update` arrives often (15 in the smoke) and is dropped.
- Everything matched the plan; nothing in `@uncage/runtime-acp` had to change for this adapter.

## Operating systems

The user's side (the one-command installer, the CLI and the background agent) on each OS. Details of the service per OS are in the next section.

| OS | How it was verified | Status |
| --- | --- | --- |
| macOS | Real device (macOS 26.6.2, arm64): live E2E with a real Claude Code, connected-demo end to end (2026-11-07) and `connected-live` after the platform merge (2026-11-08, 1/1); installer tests and the CI platform job on macos-latest | **Verified on a real device** |
| Linux | CI on ubuntu-latest (agent and CLI suites, installer tests, shellcheck of the rendered install.sh, the real-service test); local Docker, the full chain on `debian:bookworm-slim` without Node (install.sh installed Node 22 with fnm and the CLI, setup approved, agent online, a run completed); a systemd-booted `debian:bookworm` container (linger, `uncage agent install`, the unit active and restarted after `kill -9`, doctor flagging a removed pinned Node) | **CI verified, awaiting real-device confirmation** |
| Windows | CI on windows-latest: `install.ps1` executed under Windows PowerShell 5.1 and pwsh 7 (scenarios with fakes), the agent and CLI suites, and a real scheduled task (registered for the runner user, the agent restarted by its supervisor, uninstall leaving nothing). The runners are administrators, so the standard-user path and the Run-key fallback are not proven | **CI verified, awaiting real-device confirmation** |

## Operating systems: the background agent (`uncage agent install`)

The agent runs as a per-user service, pinned to the Node binary that ran `uncage agent install` (its realpath, never a version-manager shim). `uncage doctor` checks that the pinned Node still exists and is at least 22 (fix: `uncage agent install`).

| OS | Service | Status | What ran (2026-11-08) |
| --- | --- | --- | --- |
| macOS | launchd user agent `~/Library/LaunchAgents/dev.uncage.agent.plist` | Unchanged from 0.2 (the plist is byte-for-byte the same, the same `launchctl bootout` / `bootstrap gui/<uid>` calls) | Unit tests with an injected `launchctl` on macos-latest and locally. No real launchd install was made in this check |
| Linux | systemd user unit `~/.config/systemd/user/uncage-agent.service` (`Restart=on-failure`, `RestartSec=10`); without a user systemd, the foreground (`uncage agent`) | **CI verified, awaiting real-device confirmation** | ubuntu-latest: agent and CLI suites, installer tests, shellcheck of the rendered install.sh, and the real-service test (`UNCAGE_SERVICE_TESTS=1`, see the CI run notice for whether the runner had a user systemd). Local Docker (`UNCAGE_DOCKER_TESTS=1 pnpm --filter @uncage/cli exec vitest run --project docker`): (1) `debian:bookworm-slim` without Node: install.sh from the real hub installed Node 22.23.4 with fnm and the CLI, setup was approved, the agent came online, and a codex run (testkit fake) completed; `uncage agent install` fell back to the foreground. (2) A systemd-booted `debian:bookworm`: enable-linger, `uncage agent install`, the unit active, restarted after `kill -9` (about 10 s), doctor flagged the pinned Node once it was removed |
| Windows | Task Scheduler task `UncageAgent` (current user's logon, least privilege, no UAC), with an `HKCU\…\Run` fallback when Task Scheduler answers "Access is denied" | **CI verified, awaiting real-device confirmation** | windows-latest: agent and CLI suites (paths, icacls permissions, `.cmd` shims resolved without a shell), install.ps1 scenarios, and the real-service test: the task registered for the runner user, the agent restarted after exit 75 by its `--supervise` process, uninstall leaving nothing; and the built `bin.js agent --supervise` with a stub website: the real agent running, restart replacing the process tree, uninstall stopping every process. GitHub's Windows runners are administrators, so the standard-user path (and the Run-key fallback) is not proven yet |

Notes:

- Windows: Task Scheduler's RestartOnFailure does not restart a program that exits non-zero (seen in CI), so the task runs `node bin.js agent --supervise --log-file <log>`. The supervisor restarts the agent (10 s after a failure, 1 s after a self-upgrade) and writes `supervisor.pid` beside the log; uninstall stops that process tree, because ending the task only stops `conhost`.
- Linux: `loginctl enable-linger $USER` keeps the agent running after logout (doctor warns when it is off).
- The pinned Node can disappear under the service: `brew upgrade node` (or `node@22`) deletes the old Cellar folder the service points at, and so does removing an nvm / fnm version. `uncage doctor` flags it (`Background agent Node … no longer exists`); run `uncage agent install` again with the Node you use now.
- Windows: paths containing `%` are refused at install (Task Scheduler expands `%NAME%` in the program, its arguments and the working folder). Before killing the supervisor tree, the service checks that the pid in `supervisor.pid` still belongs to a `--supervise` process of this CLI; a stale file is removed. The agent's stdout / stderr go to `agent.err.log`. Logs are capped at 10 MB (one `.1` file kept), checked at every agent start.
- Manual check on a real device: `uncage agent install`, `uncage agent status`, log out and back in (Windows) or reboot, `uncage doctor`, then `uncage agent uninstall`.

## How to re-verify

- Claude Code, full live E2E: `pnpm build && UNCAGE_LIVE=1 pnpm e2e:live`. It needs a logged-in `claude`, Google Chrome and Node ≥ 22.18, and it uses a little Claude usage (about 3 minutes of short runs). Codex must be absent for spec 1 as written. Ports 4795–4798 and 3102–3105 must be free. Facts the composer specs observe (model list, the picked model, plan-mode cards, the `auto` outcome) are written to `e2e/live/results/composer-live.json`.
- Claude Code, single smoke run: `pnpm --filter @uncage/runtime-claude smoke`. It costs a few tokens and needs a logged-in `claude`. It runs in a fresh tmp dir and records the raw SDK messages to `sdk-messages.jsonl` there, so you can diff their shapes against `packages/runtime-claude/src/fixtures/`. Composer flags: `-- --image $PWD/e2e/fixtures/uncage-42.png` (image + resume with a file), `-- --permission-mode acceptEdits` (no approval expected), `--model <id>`, `--effort <level>`. Connected mode: `-- --site` (site tools via MCP, a confirmation tool, a skill).
- Connected Mode: `pnpm build`, then from `e2e/`: `pnpm exec playwright test --project=connected-mock`, `UNCAGE_DOCKER_TESTS=1 pnpm exec playwright test --project=connected-multinode` (needs Docker and pulls nothing if the two images are present), `UNCAGE_LIVE=1 pnpm exec playwright test --project=connected-live` (a logged-in `claude`; about 2 minutes of model time). Ports 3210, 3220–3222 and 3230 must be free.
- Claude Code over ACP: `pnpm build`, then `pnpm --filter @uncage/runtime-acp smoke` (a few tokens; it records the ACP traffic to `acp-traffic.jsonl` in its tmp dir with mode 0600, redacted as it is written: MCP bearer tokens, the agent's `_auth/status_update` account details and e-mail addresses are removed; the log is deleted when the script ends unless you pass `--keep-traffic`) and, from `e2e/`, `UNCAGE_LIVE=1 pnpm exec playwright test --project=connected-acp-live` (about 2 minutes of model time; port 3240 must be free). Both use the pinned `@agentclientprotocol/claude-agent-acp` in `e2e/node_modules`. Never point them at another agent without its own review.
- Codex: there is no live check yet. `pnpm --filter @uncage/runtime-codex test` runs the adapter against the fake app-server.
