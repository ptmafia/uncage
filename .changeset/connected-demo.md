---
'@uncage/cli': minor
---

`UNCAGE_HOME` (absolute path) moves Connected Mode state (`~/.uncage/agent.yaml`, site data, the
`~/Uncage` workspaces) for tests and dev runs while `HOME` stays untouched, so Claude Code keeps its
login. Applies to `uncage setup` (only with `--no-daemon`), `uncage agent`, `uncage sites` and
`uncage activity`. New reference site `examples/connected-demo` with mock, multi-node and live E2E.
