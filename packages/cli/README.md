# @uncage/cli

The `uncage` command. `uncage serve` starts the local daemon (loopback only, bearer token in `~/.uncage/token`, PGlite data in `~/.uncage/data`) with the Claude Code and Codex adapters. `uncage doctor` checks Node, the data dir, the token, the server and each runtime, and prints a fix for every failure. `uncage doctor --export-events <sessionId>` exports a redacted event log for bug reports. Run `uncage --help` for flags (`--port`, `--workspace`, `--data-dir`, `--token-file`).

API: [`src/index.ts`](./src/index.ts) (every export is documented with JSDoc) · Project overview: [README](../../README.md)
