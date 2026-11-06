# Runtime compatibility

Versions each adapter has been verified against. Live checks run on macOS (darwin-arm64).

| Runtime | Adapter | SDK / CLI version | Verified | Status |
| --- | --- | --- | --- | --- |
| Claude Code | `@uncage/runtime-claude` | `@anthropic-ai/claude-agent-sdk` 0.3.318 (bundled CLI 2.1.318); `claude` CLI on PATH 2.1.318 | 2026-11-06 | Live smoke passed: one approval request (Write, auto-allowed), `tool.completed`, `run.completed`, `hello.txt` created |

## How to re-verify

- Claude Code: `pnpm --filter @uncage/runtime-claude smoke`. It costs a few tokens and needs a logged-in `claude`. It runs in a fresh tmp dir and records the raw SDK messages to `sdk-messages.jsonl` there, so you can diff their shapes against `packages/runtime-claude/src/fixtures/`.
