# Uncage

[![CI](https://github.com/ptmafia/uncage/actions/workflows/ci.yml/badge.svg)](https://github.com/ptmafia/uncage/actions/workflows/ci.yml)

**Let your website drive Claude Code on your users’ own computers.**

Your website gives the instructions. Each user’s own Claude Code does the work, on their own computer, under their own login, and calls your website’s tools as that user. The conversation, the approvals and the results stay on your site.

- **One command for the user, on macOS, Linux or Windows.** Your page shows `curl -fsSL https://your.site/api/uncage/install.sh | bash` (on Windows `irm https://your.site/api/uncage/install.ps1 | iex`). The installer checks the computer, asks `[Y/n]` before each step (Node.js 22 through the user’s own version manager, then the CLI), without `sudo` or admin rights, and offers to run `uncage setup https://your.site`. The user approves the computer in the browser, a background agent dials out to your site, and the page shows it online. No ports, no tunnels.
- **A chat on your site.** `<AgentChat>` streams answers and tool steps, shows Allow / Deny cards, Stop, attachments, model and permission pickers, and keeps history across reloads.
- **Your capabilities, your rules.** Declare site tools with `defineTool` (zod schema + handler). The handler runs in your backend as the signed-in user and can pull files from the run’s workspace. Give Claude Code your formats and templates as skills.
- **Safe by construction.** Your site never sends code or shell to the user’s computer, only tool schemas, skill text and a fixed set of commands. Bypassing approvals can only be enabled by the user, locally. Everything a site does is logged on the user’s computer.
- **Runs where your site runs.** In a Node server (traditional mode: zero dependencies, WebSocket), or on Vercel, Cloudflare Workers and other serverless platforms (FaaS mode: Postgres only, HTTP streaming). Plug in your sign-in with `getUser(req)`, keep a replica of every conversation on your site, run several nodes with Postgres (and Redis if you like).

**Help site (for developers and coding agents): https://uncage.vercel.app/docs/** · [llms.txt](https://uncage.vercel.app/docs/llms.txt) · [Skill for coding agents](skills/uncage/SKILL.md)

> Status: 0.3 makes the hub platform-agnostic (traditional mode and FaaS mode; [migrating from 0.2](https://uncage.vercel.app/docs/reference/migrate-from-0-2/)). The user’s side needs Node.js 22+ and runs on macOS (verified live); Linux and Windows are CI verified, awaiting real-device confirmation. Claude Code is verified live, end to end ([compatibility](docs/compatibility.md)); Codex is implemented but not yet verified against a real binary and has no site-tool support. Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (Gemini CLI, OpenCode, Claude Code’s ACP adapter, …) can be offered too, with `runtimes.acp` in `~/.uncage/agent.yaml`; Claude Code’s ACP adapter is verified live. Local Mode (the 0.1 daemon + chat, with no hub) keeps working and is documented in the help site.

## Try it in 5 minutes

Run the reference website and connect your own computer to it. You need macOS, Linux or Windows, Node.js 22.18+, pnpm, and Claude Code installed and signed in (`npm i -g @anthropic-ai/claude-code`, run `claude`, type `/login`).

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
3. Send **做一个介绍 Uncage 的落地页并发布** (“build a landing page about Uncage and publish it”). Claude Code works on your computer in `~/Uncage/localhost-3200/<session>/`, calls the site’s `create_asset` tool, writes the page, and asks you to confirm `publish_asset`, which pulls the folder from your computer into the site.
4. Open **素材** (`/assets`) to see the published page. Stop the agent and reload the chat: the whole conversation is still there.

## Add it to your website

```sh
npm i @uncage/hub @uncage/react-ui zod
```

An excerpt to show the shape, in traditional mode (`./auth.ts` is your own sign-in). The complete, type-checked files are in the [Connected Mode quickstart](https://uncage.vercel.app/docs/start/quickstart-connected/) and [Mount the hub](https://uncage.vercel.app/docs/guides/mount-the-hub/). On Vercel, Cloudflare Workers or another serverless platform, see [Choose a deployment mode](https://uncage.vercel.app/docs/start/choose-deployment-mode/).

```ts
// server.ts — mount the hub in your Node server (Express here; Fastify, Hono, Next.js custom servers work too)
import { createServer } from 'node:http';
import { createHub, defineTool } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
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

const hub = await createHub({
  publicUrl: 'https://your.site',
  getUser: getSessionUser,
  store: await pgliteHubStore({ dataDir: './.uncage-hub' }), // embedded Postgres in a folder
  tools: [saveNote],
});
const app = express();
app.use(toNodeHandler(hub)); // before body parsers
const server = createServer(app);
attachWebSocket(hub, server); // computers connect here (WebSocket)
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

You also need an approval page at `/device` (signed-in only, unframable, decided with a CSRF-protected POST). The [Connected Mode quickstart](https://uncage.vercel.app/docs/start/quickstart-connected/) has every file for a Next.js app, type-checked in CI; [Mount the hub](https://uncage.vercel.app/docs/guides/mount-the-hub/) covers Express, Fastify, Hono and Next.js custom servers; the Deploy pages cover [Node](https://uncage.vercel.app/docs/deploy/node/), [Next.js on Vercel](https://uncage.vercel.app/docs/deploy/vercel/), [Cloudflare Workers](https://uncage.vercel.app/docs/deploy/cloudflare-workers/) and [other Fetch platforms](https://uncage.vercel.app/docs/deploy/other-fetch-platforms/).

## Local Mode

When the agent runs on the same machine as your app (an internal tool, a dev dashboard), skip the hub: run `npx uncage serve --workspace <dir>`, add a same-origin proxy route (`createUncageHandler()` from `@uncage/server/proxy`) and render `<AgentChat>`. See the [Local Mode quickstart](https://uncage.vercel.app/docs/start/quickstart-local/) (5 minutes) and [Local Mode in depth](https://uncage.vercel.app/docs/reference/local-mode/).

## Documentation

| | |
| --- | --- |
| [How it works](https://uncage.vercel.app/docs/start/how-it-works/) | Architecture, transports, and the connect → task → tool call → result sequence |
| [Choose a deployment mode](https://uncage.vercel.app/docs/start/choose-deployment-mode/) · [Deploy](https://uncage.vercel.app/docs/deploy/node/) | Traditional (Node) or FaaS (Vercel, Cloudflare Workers, other Fetch platforms), with complete code per platform |
| [Concepts](https://uncage.vercel.app/docs/concepts/) · [Trust model](https://uncage.vercel.app/docs/concepts/trust-model/) | The vocabulary, and what a website can and cannot do on a user’s computer |
| [Guides](https://uncage.vercel.app/docs/guides/define-tools/) | Tools, skills, `selectManifest`, site storage, multi-node, auth and `/device`, custom UI, local policy |
| [Reference](https://uncage.vercel.app/docs/reference/cli/) | CLI, HTTP API, error codes, security, troubleshooting, migrating from 0.2, generated TypeScript API |
| [For coding agents](https://uncage.vercel.app/docs/start/for-coding-agents/) | Every page as markdown (`.md`), `llms.txt`, `llms-full.txt`, the Uncage skill, copy-paste prompts |

中文：[概览](https://uncage.vercel.app/docs/zh-cn/)、[快速上手](https://uncage.vercel.app/docs/zh-cn/start/quickstart-connected/)、[概念](https://uncage.vercel.app/docs/zh-cn/concepts/)。

## Packages

| Package | What it is |
| --- | --- |
| [`@uncage/hub`](packages/hub) | Connected Mode hub for your website: a Fetch handler for any platform, Node parts in `@uncage/hub/node` |
| [`@uncage/agent`](packages/agent) | The daemon on the user’s computer (run by `uncage agent`) |
| [`@uncage/cli`](packages/cli) | `uncage setup` / `agent` / `sites` / `runtimes` / `activity`, and `serve` / `doctor` for Local Mode |
| [`@uncage/react-ui`](packages/react-ui) | `<AgentChat>`, `<ConnectMachine>`, `<ApproveDevice>`, `<MachineStatus>` |
| [`@uncage/react`](packages/react) | Headless store and hooks |
| [`@uncage/client`](packages/client) | Browser transport with resumable SSE |
| [`@uncage/server`](packages/server) | Local Mode daemon and same-origin proxy |
| [`@uncage/core`](packages/core) | Sessions, runs, approvals, event log (PGlite) |
| [`@uncage/protocol`](packages/protocol) | Wire types, Zod schemas, error catalog |
| [`@uncage/runtime-claude`](packages/runtime-claude) | Claude Code adapter (Claude Agent SDK) |
| [`@uncage/runtime-codex`](packages/runtime-codex) | Codex adapter (app-server JSON-RPC) |
| [`@uncage/runtime-acp`](packages/runtime-acp) | Any Agent Client Protocol agent over stdio (Gemini CLI, OpenCode, Claude Code’s ACP adapter, …) |
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
