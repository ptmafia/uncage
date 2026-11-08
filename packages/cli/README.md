# @uncage/cli

The `uncage` command.

```sh
npx uncage serve [--port 4783] [--workspace <dir>] [--data-dir <dir>] [--token-file <file>]
npx uncage doctor            # checks Node, data dir, token, server, Claude Code / Codex; prints a fix for each ✗
npx uncage doctor --export-events <sessionId> [--out file] [--include-content]
```

`serve` starts the local daemon on `127.0.0.1` (loopback only), creates `~/.uncage/token` (mode 600) and `~/.uncage/data`, and runs Claude Code (and Codex, if installed) in `--workspace`. Optional `uncage.config.yaml` in the working directory overrides defaults (port, allowed roots, approval TTL, `security.allowBypass`). Env: `UNCAGE_PORT`, `UNCAGE_LOG_LEVEL`, `UNCAGE_ALLOW_BYPASS=1`.

Prerequisite: Claude Code installed and logged in (`npm i -g @anthropic-ai/claude-code`, then `claude` → `/login`).

## Connected Mode (0.2)

End users install the CLI globally, either with the website's installer (`curl -fsSL https://your.site/api/uncage/install.sh | bash`) or with `npm i -g @uncage/cli`, then:

```sh
uncage setup https://your.site   # connect this computer to a website (approve in the browser)
uncage agent                     # run the agent in the foreground (setup installs it as a background service)
uncage sites [remove <host>]     # list or disconnect sites
uncage activity                  # what sites did on this computer (redacted)
uncage --version
```

Don't run `setup` through `npx`: the background service it installs points at the CLI it was started from, and the npx cache is not a stable place.

State lives in `~/.uncage/agent.yaml` (mode 600) and `~/Uncage/<site>/<session>/`; set `UNCAGE_HOME` to relocate it.

## Quick start (Next.js)

```sh
npm i @uncage/server @uncage/react-ui @uncage/cli
npx uncage serve --workspace /path/to/project   # keep running; needs Claude Code installed and logged in
```

```ts
// app/api/uncage/[...path]/route.ts
import { createUncageHandler } from '@uncage/server/proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const { GET, POST, PATCH } = createUncageHandler();
```

```tsx
// app/page.tsx
'use client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

export default function Page() {
  return (
    <div style={{ height: '100vh' }}>
      <UncageProvider><AgentChat locale="zh-CN" /></UncageProvider>
    </div>
  );
}
```

Then `npm run dev` and open http://localhost:3000. `npx uncage doctor` checks your setup and prints a fix for every problem.

---

Part of **Uncage** — bring Claude Code (and Codex) into your own app with approvals, streaming and a ready-made UI. Start with [`@uncage/react-ui`](https://www.npmjs.com/package/@uncage/react-ui) for the 5-minute setup. MIT licensed.
