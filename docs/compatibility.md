# Runtime compatibility

These are the versions each adapter has been verified against. Live checks run on macOS (darwin-arm64).

| Runtime | Adapter | SDK / CLI version | Verified | Status |
| --- | --- | --- | --- | --- |
| Claude Code | `@uncage/runtime-claude` | `@anthropic-ai/claude-agent-sdk` 0.3.318 (bundled CLI 2.1.318); `claude` CLI on PATH 2.1.318 | 2026-11-06 | **Live E2E passed** (10/10 on the latest run, see the run records below). A `resume` of a session Claude Code no longer has was checked live: it yields `native.session_lost` (the session becomes read-only). Live smoke passed earlier: one approval request (Write, auto-allowed), `tool.completed`, `run.completed`, `hello.txt` created. |
| Codex | `@uncage/runtime-codex` | none (not installed on the test machine) | 2026-11-06 (mock only) | **Implemented, verified only against a fake app-server** (`@uncage/testkit` fake codex). Protocol facts were checked against the official `openai/codex` app-server-protocol schema and two third-party clients. Unverified against a real binary: whether `codex app-server` needs `--stdio` (one client passes it), and real-binary process and auth behavior. When it isn't installed, the UI and `uncage doctor` show `not_installed` with `npm i -g @openai/codex && codex login`. This is asserted live. |

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
- `bypassPermissions` is passed to Claude Code (with `allowDangerouslySkipPermissions: true`) only when the server runs with `security.allowBypass`. Otherwise the adapter refuses the run with `policy_denied`, as a second check after core. It wasn't run live.

## How to re-verify

- Claude Code, full live E2E: `pnpm build && UNCAGE_LIVE=1 pnpm e2e:live`. It needs a logged-in `claude`, Google Chrome and Node ≥ 22.18, and it uses a little Claude usage (about 1–2 minutes of short runs). Codex must be absent for spec 1 as written.
- Claude Code, single smoke run: `pnpm --filter @uncage/runtime-claude smoke`. It costs a few tokens and needs a logged-in `claude`. It runs in a fresh tmp dir and records the raw SDK messages to `sdk-messages.jsonl` there, so you can diff their shapes against `packages/runtime-claude/src/fixtures/`. Composer flags: `-- --image $PWD/e2e/fixtures/uncage-42.png` (image + resume with a file), `-- --permission-mode acceptEdits` (no approval expected), `--model <id>`, `--effort <level>`.
- Codex: there is no live check yet. `pnpm --filter @uncage/runtime-codex test` runs the adapter against the fake app-server.
