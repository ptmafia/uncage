# @uncage/cli

## 0.2.0

- New commands for Connected Mode: `uncage setup <url>` (connect this computer to a website), `uncage agent` (`uninstall`), `uncage sites` (`remove`), `uncage activity`.
- `uncage --version` (also `-v`, `version`) prints the CLI version.
- `UNCAGE_HOME` (absolute path) relocates Connected Mode state for tests and dev runs while `HOME` stays untouched.
- `uncage doctor` accepts `--port` and `--help`, honors `UNCAGE_URL`, and checks git-ignore on the configured workspace.
- `uncage serve`, `doctor` and event export otherwise behave as in 0.1.
