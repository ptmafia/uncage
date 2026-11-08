# Uncage

[![CI](https://github.com/ptmafia/uncage/actions/workflows/ci.yml/badge.svg)](https://github.com/ptmafia/uncage/actions/workflows/ci.yml)

**Let your website drive Claude Code on your users’ own computers.**

Your website gives the instructions. Each user’s own Claude Code does the work, on their own Mac, under their own login, and calls your website’s tools as that user. The conversation, the approvals and the results stay on your site.

- **Two commands for the user.** Your page shows `curl -fsSL https://your.site/api/uncage/install.sh | bash` and `uncage setup https://your.site`. The user approves the computer in the browser, a background agent dials out to your site, and the page shows it online. No ports, no tunnels.
- **A chat on your site.** `<AgentChat>` streams answers and tool steps, shows Allow / Deny cards, Stop, attachments, model and permission pickers, and keeps history across reloads.
- **Your capabilities, your rules.** Declare site tools with `defineTool` (zod schema + handler). The handler runs in your backend as the signed-in user and can pull files from the run’s workspace. Give Claude Code your formats and templates as skills.
- **Safe by construction.** Your site never sends code or shell to the user’s computer, only tool schemas, skill text and a fixed set of commands. Bypassing approvals can only be enabled by the user, locally. Everything a site does is logged on the user’s computer.
- **Production shape.** Plug in your sign-in with `getUser(req)`. Keep a replica of every conversation on your site. Run the hub on several nodes with Postgres and Redis.

**Help site (for developers and coding agents): https://uncage.vercel.app/docs/** · [llms.txt](https://uncage.vercel.app/docs/llms.txt) · [Skill for coding agents](skills/uncage/SKILL.md)

> Status: Connected Mode is new in 0.2 (`@uncage/hub`, `@uncage/agent`, `uncage setup`). The user’s side runs on macOS with Node.js 22+. Claude Code is verified live, end to end ([compatibility](docs/compatibility.md)); Codex is implemented but not yet verified against a real binary and has no site-tool support. Local Mode (the 0.1 daemon + chat, with no hub) keeps working and is documented in the help site.

## Try it in 5 minutes

Run the reference website and connect your own Mac to it. You need macOS, Node.js 22.18+, pnpm, and Claude Code installed and signed in (`npm i -g @anthropic-ai/claude-code`, run `claude`, type `/login`).

```sh
git clone https://github.com/ptmafia/uncage && cd uncage
pnpm install && pnpm build
cd examples/connected-demo && pnpm start        # http://localhost:3200
```

1. Open http://localhost:3200 and sign in with any username (demo-only sign-in).
2. The chat shows **连接你的电脑** (connect your computer). In a second terminal, from `examples/connected-demo`, run the setup command with this repo’s CLI:

   ```sh
   node ../../packages/cli/dist/bin.js setup http://localhost:3200 --no-daemon
   node ../../packages/cli/dist/bin.js agent       # keep it running
   ```

   `setup` opens `/device?code=…`: check that the code matches and click **批准** (approve). (Prefix both commands with `UNCAGE_HOME=/tmp/uncage-demo` to leave your `~/.uncage` untouched.)
3. Send **做一个介绍 Uncage 的落地页并发布** (“build a landing page about Uncage and publish it”). Claude Code works on your Mac in `~/Uncage/localhost-3200/<session>/`, calls the site’s `create_asset` tool, writes the page, and asks you to confirm `publish_asset`, which pulls the folder from your Mac into the site.
4. Open **素材** (`/assets`) to see the published page. Stop the agent and reload the chat: the whole conversation is still there.

## Add it to your website

```sh
npm i @uncage/hub @uncage/react-ui zod
```

An excerpt to show the shape (`./auth.ts` is your own sign-in). The complete, type-checked files are in the [Connected Mode quickstart](https://uncage.vercel.app/docs/start/quickstart-connected/) and [Mount the hub](https://uncage.vercel.app/docs/guides/mount-the-hub/).

```ts
// server.ts — mount the hub in your Node server (Express here; Fastify, Hono, Next.js custom servers work too)
import { createServer } from 'node:http';
import { createHub, defineTool, toNodeHandler } from '@uncage/hub';
import express from 'express';
import { z } from 'zod';
import { getSessionUser } from './auth.ts'; // your sign-in: (req: Request) => Promise<{ id: string } | null>

const notes = new Map<string, Array<{ title: string; text: string }>>(); // stand-in for your database

const saveNote = defineTool({
  name: 'save_note',
  description: 'Save a note to the signed-in user’s notes on the website.',
  input: z.object({ title: z.string(), text: z.string() }),
  // Runs in your backend, as the signed-in user.
  handler: async ({ title, text }, ctx) => {
    notes.set(ctx.user.id, [...(notes.get(ctx.user.id) ?? []), { title, text }]);
    return { saved: title };
  },
});

const hub = await createHub({ publicUrl: 'https://your.site', getUser: getSessionUser, tools: [saveNote] });
const app = express();
app.use(toNodeHandler(hub)); // before body parsers
const server = createServer(app);
hub.attach(server); // computers connect here (WebSocket)
server.listen(3000);
```

```tsx
// a page on the same origin
import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

export default function Page() {
  return (
    <div style={{ height: '100vh' }}>
      <UncageProvider>
        <AgentChat />
      </UncageProvider>
    </div>
  );
}
```

You also need an approval page at `/device` (signed-in only, unframable, decided with a CSRF-protected POST). The [Connected Mode quickstart](https://uncage.vercel.app/docs/start/quickstart-connected/) has every file for a Next.js app, type-checked in CI; [Mount the hub](https://uncage.vercel.app/docs/guides/mount-the-hub/) covers Express, Fastify, Hono and Next.js custom servers.

## Local Mode

When the agent runs on the same machine as your app (an internal tool, a dev dashboard), skip the hub: run `npx uncage serve --workspace <dir>`, add a same-origin proxy route (`createUncageHandler()` from `@uncage/server/proxy`) and render `<AgentChat>`. See the [Local Mode quickstart](https://uncage.vercel.app/docs/start/quickstart-local/) (5 minutes) and [Local Mode in depth](https://uncage.vercel.app/docs/reference/local-mode/).

## Documentation

| | |
| --- | --- |
| [How it works](https://uncage.vercel.app/docs/start/how-it-works/) | Architecture and the connect → task → tool call → result sequence |
| [Concepts](https://uncage.vercel.app/docs/concepts/) · [Trust model](https://uncage.vercel.app/docs/concepts/trust-model/) | The vocabulary, and what a website can and cannot do on a user’s computer |
| [Guides](https://uncage.vercel.app/docs/guides/define-tools/) | Tools, skills, `selectManifest`, site storage, multi-node, auth and `/device`, custom UI, local policy |
| [Reference](https://uncage.vercel.app/docs/reference/cli/) | CLI, HTTP API, error codes, security, troubleshooting, generated TypeScript API |
| [For coding agents](https://uncage.vercel.app/docs/start/for-coding-agents/) | Every page as markdown (`.md`), `llms.txt`, `llms-full.txt`, the Uncage skill, copy-paste prompts |

中文：[概览](https://uncage.vercel.app/docs/zh-cn/)、[快速上手](https://uncage.vercel.app/docs/zh-cn/start/quickstart-connected/)、[概念](https://uncage.vercel.app/docs/zh-cn/concepts/)。

## Packages

| Package | What it is |
| --- | --- |
| [`@uncage/hub`](packages/hub) | Connected Mode hub for your website’s Node backend |
| [`@uncage/agent`](packages/agent) | The daemon on the user’s computer (run by `uncage agent`) |
| [`@uncage/cli`](packages/cli) | `uncage setup` / `agent` / `sites` / `activity`, and `serve` / `doctor` for Local Mode |
| [`@uncage/react-ui`](packages/react-ui) | `<AgentChat>`, `<ConnectMachine>`, `<ApproveDevice>`, `<MachineStatus>` |
| [`@uncage/react`](packages/react) | Headless store and hooks |
| [`@uncage/client`](packages/client) | Browser transport with resumable SSE |
| [`@uncage/server`](packages/server) | Local Mode daemon and same-origin proxy |
| [`@uncage/core`](packages/core) | Sessions, runs, approvals, event log (PGlite) |
| [`@uncage/protocol`](packages/protocol) | Wire types, Zod schemas, error catalog |
| [`@uncage/runtime-claude`](packages/runtime-claude) | Claude Code adapter (Claude Agent SDK) |
| [`@uncage/runtime-codex`](packages/runtime-codex) | Codex adapter (app-server JSON-RPC) |
| [`@uncage/testkit`](packages/testkit) | Fake runtime adapter and adapter contract tests (private) |

## Development

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm lint && pnpm test
pnpm e2e:mock                    # Playwright against a fake runtime (system Chrome)
UNCAGE_LIVE=1 pnpm e2e:live      # against REAL Claude Code (uses a little Claude usage)
pnpm --filter docs dev           # the help site, http://localhost:4321/uncage/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for CI, releases and the help site. MIT licensed.
