# @uncage/cli

## 0.3.0

### Minor Changes

- Uncage 0.3: the hub runs anywhere (traditional mode on a Node server, FaaS mode on Vercel, Cloudflare Workers and other Fetch platforms with only Postgres), computers connect over WebSocket or HTTPS streaming (connected protocol 2), any Agent Client Protocol agent can be offered (new `@uncage/runtime-acp`, auto-detected from the ACP registry with consent), and the one-command installer supports macOS, Linux and Windows. Breaking: `@uncage/hub` root is Web-standard (`toNodeHandler`, `attachWebSocket`, `pgliteHubStore` move to `@uncage/hub/node`), `createHub` requires `store`, `hub.handler` → `hub.fetch`, `hub.attach` → `attachWebSocket`, agents must be 0.3 or newer. See https://uncage-dev.vercel.app/docs/reference/migrate-from-0-2/

### Patch Changes

- Updated dependencies
  - @uncage/agent@0.3.0
  - @uncage/core@0.3.0
  - @uncage/protocol@0.3.0
  - @uncage/runtime-acp@0.3.0
  - @uncage/runtime-claude@0.3.0
  - @uncage/runtime-codex@0.3.0
  - @uncage/server@0.3.0

## 0.2.0

- New commands for Connected Mode: `uncage setup <url>` (connect this computer to a website), `uncage agent` (`uninstall`), `uncage sites` (`remove`), `uncage activity`.
- `uncage --version` (also `-v`, `version`) prints the CLI version.
- `UNCAGE_HOME` (absolute path) relocates Connected Mode state for tests and dev runs while `HOME` stays untouched.
- `uncage doctor` accepts `--port` and `--help`, honors `UNCAGE_URL`, and checks git-ignore on the configured workspace.
- `uncage serve`, `doctor` and event export otherwise behave as in 0.1.
