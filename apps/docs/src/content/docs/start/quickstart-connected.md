---
title: 'Quickstart: Connected Mode'
description: Add Uncage to a Next.js app so signed-in users can connect their own computer and drive their own Claude Code from your site, with one site tool. About 15 minutes.
---

By the end of this page:

- your Next.js app serves the Uncage hub at `/api/uncage`;
- a page shows `<AgentChat>`, which first offers “Connect your computer”;
- `/device` is where users approve their computer;
- Claude Code on the user’s computer can call one of your tools, `save_note`, which runs in your server as that user.

You play both roles: the website developer, then the user who connects a computer.

## Copy prompt for your coding agent

If you use Claude Code, Codex or another coding agent, paste this into it instead of following the steps by hand:

```text wrap
Add Uncage Connected Mode to this Next.js (App Router) app, following https://ptmafia.github.io/uncage/start/quickstart-connected.md exactly.
Read https://ptmafia.github.io/uncage/skills/uncage/SKILL.md first and follow its rules.
1. Install @uncage/hub, @uncage/react-ui and zod.
2. Create lib/auth.ts, lib/tools.ts, lib/uncage-hub.ts, lib/hub-registry.ts, server.ts, app/uncage/page.tsx, app/device/page.tsx, app/device/actions.ts, app/device/approve-page.tsx and the headers in next.config.ts, as on that page.
3. Wire lib/auth.ts to this app's existing sign-in (find how the app reads the current user). Do not keep the development user unless the app has no sign-in at all.
4. Change the "dev" and "start" scripts to run server.ts with node (Node.js 22.18 or newer), set "type": "module" in package.json and "allowImportingTsExtensions": true in tsconfig.json.
5. Add .uncage-hub/ to .gitignore.
Verify: start the dev server, then curl -s http://localhost:3000/api/uncage/install.sh | head -3 prints the installer, and curl -sI http://localhost:3000/device shows the headers Content-Security-Policy: frame-ancestors 'none' and X-Frame-Options: DENY (no ?code=: unknown codes count as failed guesses and are rate limited). Report what you changed and anything you could not wire.
```

## Before you start

- **Website side:** a Next.js 16 app (App Router) that you run with Node. Node.js **22.18 or newer**, because the custom server below is a `.ts` file that Node runs directly. Starting fresh: `npx create-next-app@latest my-site` (TypeScript, App Router).
- **User side (your own Mac for this test):** macOS, Node.js 22+, and Claude Code installed and signed in: `npm i -g @anthropic-ai/claude-code`, then run `claude` once and type `/login`.

:::caution[Why a custom server]
The hub keeps a WebSocket open to every connected computer, so it needs a long-running Node process with access to the HTTP server. Next.js route handlers alone cannot accept WebSocket upgrades, and serverless platforms (such as Vercel functions) cannot host the hub. On Vercel, run the hub as its own Node service; see [Mount the hub](/uncage/guides/mount-the-hub/#serverless-hosting-vercel-netlify).
:::

## 1. Install

```sh
npm i @uncage/hub @uncage/react-ui zod
```

## 2. Who is signed in

The hub asks your app who the user is, on every browser request. For this quickstart, use a fixed development user. The [auth guide](/uncage/guides/auth-and-device-approval/) shows how to connect a real sign-in.

```ts title="lib/auth.ts"
import type { HubUser } from '@uncage/hub';

/**
 * Replace both functions with your real sign-in before you deploy.
 * `userFromRequest` is used by the hub (a Fetch `Request`); `currentUser` by your pages.
 */
export async function userFromRequest(_req: Request): Promise<HubUser | null> {
  return developmentUser();
}

export async function currentUser(): Promise<HubUser | null> {
  return developmentUser();
}

function developmentUser(): HubUser {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('lib/auth.ts still returns the development user: connect it to your sign-in.');
  }
  return { id: 'dev-user', name: 'Developer' };
}
```

## 3. Define a tool

A site tool is a capability of your website that Claude Code can call. Its handler runs **in your server**, as the user who owns the session. The user’s computer only receives the name, the description and the JSON Schema generated from `input`.

```ts title="lib/tools.ts"
import { defineTool, type SiteTool } from '@uncage/hub';
import { z } from 'zod';

/** Stand-in for your database. */
const notes = new Map<string, Array<{ id: string; title: string; text: string }>>();

export const saveNote = defineTool({
  name: 'save_note',
  description: 'Save a note to the signed-in user’s notes on the website. Returns the note id.',
  input: z.object({
    title: z.string().min(1).max(120),
    text: z.string().min(1).max(10_000),
  }),
  handler: async ({ title, text }, ctx) => {
    const mine = notes.get(ctx.user.id) ?? [];
    const note = { id: `note_${mine.length + 1}`, title, text };
    notes.set(ctx.user.id, [...mine, note]);
    return { saved: note.id };
  },
});

export const tools: SiteTool[] = [saveNote];
```

## 4. Create the hub

The hub is created once, by your custom server. Your pages need it too (the approval page calls it), but Next.js bundles page code separately, so the server hands the instance over through `globalThis`.

```ts title="lib/uncage-hub.ts"
import { createHub, type Hub } from '@uncage/hub';
import { userFromRequest } from './auth.ts';
import { tools } from './tools.ts';

export function createAppHub(): Promise<Hub> {
  return createHub({
    // The URL your users open. Also what `uncage setup <url>` is given.
    publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
    getUser: userFromRequest,
    tools,
    // Keep a copy of every conversation on the website (readable while the computer is off).
    sessionStorage: 'site',
  });
}
```

```ts title="lib/hub-registry.ts"
import type { Hub } from '@uncage/hub';

const KEY = Symbol.for('my-site.uncage-hub');

/** Called once by server.ts. */
export function publishHub(hub: Hub): void {
  (globalThis as Record<symbol, unknown>)[KEY] = hub;
}

/** The hub server.ts created, for pages and Server Actions. */
export function getHub(): Hub {
  const hub = (globalThis as Record<symbol, unknown>)[KEY] as Hub | undefined;
  if (!hub) throw new Error('The Uncage hub is not running: start the app with `node server.ts`, not `next dev`.');
  return hub;
}
```

With no `store` option the hub keeps its data in `./.uncage-hub` (embedded PGlite). Add that folder to `.gitignore`.

## 5. The custom server

One Node HTTP server carries everything: the hub’s HTTP API under `/api/uncage`, the computers’ WebSockets at `/api/uncage/agent`, and the Next.js app for every other path.

```ts title="server.ts"
import { createServer } from 'node:http';
import { toNodeHandler } from '@uncage/hub';
import next from 'next';
import { publishHub } from './lib/hub-registry.ts';
import { createAppHub } from './lib/uncage-hub.ts';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT ?? 3000);

const hub = await createAppHub();
publishHub(hub);
const hubHandler = toNodeHandler(hub);

const server = createServer();
const app = next({ dev, hostname: 'localhost', port, httpServer: server });
const handle = app.getRequestHandler();
await app.prepare();

server.on('request', (req, res) => {
  // Paths under /api/uncage go to the hub; everything else falls through to Next.js.
  hubHandler(req, res, () => void handle(req, res));
});

hub.attach(server); // computers connect to ws(s)://<host>/api/uncage/agent

if (dev) {
  // Next.js hot reload uses WebSockets too; leave the hub's path to the hub.
  const upgrade = app.getUpgradeHandler();
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== `${hub.basePath}/agent`) void upgrade(req, socket, head);
  });
}

server.listen(port, () => console.log(`ready on http://localhost:${port}`));
```

Run it with Node instead of `next dev`. Node runs `server.ts` directly (it strips the types), and the files it imports use explicit `.ts` extensions, so:

```json title="package.json (excerpt)"
{
  "type": "module",
  "scripts": {
    "dev": "node server.ts",
    "build": "next build",
    "start": "NODE_ENV=production node server.ts"
  }
}
```

```json title="tsconfig.json (excerpt)"
{
  "compilerOptions": {
    "allowImportingTsExtensions": true
  }
}
```

## 6. The chat page

`<AgentChat>` talks to `/api/uncage` by default. It notices that this is a hub (not a local daemon) and switches to Connected Mode by itself: with no computer yet, it shows `<ConnectMachine>` with the two commands; afterwards, the header shows which computer the conversation runs on.

```tsx title="app/uncage/page.tsx"
'use client';
import { AgentChat, UncageProvider } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';

export default function UncagePage() {
  return (
    <div style={{ height: '100vh' }}>
      <UncageProvider>
        <AgentChat starterPrompts={['Write a short poem about this website and save it with save_note']} />
      </UncageProvider>
    </div>
  );
}
```

## 7. The approval page

`uncage setup` sends the user to `/device?code=…` on your site. Approving there gives that computer access to the user’s account, so the page must be served only to the signed-in user, must not be framable, and must record the decision with a POST that only your own origin can send. Next.js Server Actions are POST-only and check the `Origin`, which covers the last point.

```tsx title="app/device/page.tsx"
import type { ApproveDeviceProps } from '@uncage/react-ui';
import { currentUser } from '../../lib/auth.ts';
import { getHub } from '../../lib/hub-registry.ts';
import { ApprovePage } from './approve-page.tsx';

export const dynamic = 'force-dynamic';

type DeviceError = NonNullable<ApproveDeviceProps['error']>;

export default async function DevicePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code = '' } = await searchParams;
  const user = await currentUser();
  if (!user) return <p>Sign in first, then open this link again.</p>; // or redirect to your login page
  let lookup: ApproveDeviceProps['lookup'] = null;
  let error: DeviceError | undefined;
  try {
    lookup = code ? await getHub().lookupDevice(code, user) : null;
  } catch (e) {
    // Unknown codes count as failed guesses; after 10 in 10 minutes lookupDevice throws `rate_limited`.
    // Show a message instead of crashing the page.
    const err = e as { code?: string; message?: string };
    error =
      err.code === 'rate_limited'
        ? { code: 'rate_limited', message: 'Too many attempts with unknown codes. Wait a few minutes, then open the link again.' }
        : { code: 'internal_error', message: 'Could not check this code. Try again in a moment.' };
  }
  return <ApprovePage code={code} lookup={lookup} initialError={error} />;
}
```

```ts title="app/device/actions.ts"
'use server';
import { currentUser } from '../../lib/auth.ts';
import { getHub } from '../../lib/hub-registry.ts';

export type DecideResult = { result: 'ok' | 'not_found' | 'expired' } | { error: { code: string; message: string } };

/** A Server Action: a POST that Next.js only accepts from this site's own Origin. */
export async function decide(code: string, approve: boolean): Promise<DecideResult> {
  const user = await currentUser();
  if (!user) return { error: { code: 'unauthorized', message: 'Sign in again.' } };
  try {
    const hub = getHub();
    return { result: await (approve ? hub.approveDevice(code, user) : hub.denyDevice(code, user)) };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { error: { code: err.code ?? 'internal_error', message: err.message ?? 'Failed' } };
  }
}
```

```tsx title="app/device/approve-page.tsx"
'use client';
import { ApproveDevice, type ApproveDeviceProps, type ApproveDeviceState } from '@uncage/react-ui';
import '@uncage/react-ui/styles.css';
import { useState } from 'react';
import { decide } from './actions.ts';

export function ApprovePage({
  code,
  lookup,
  initialError,
}: Pick<ApproveDeviceProps, 'code' | 'lookup'> & { initialError?: ApproveDeviceProps['error'] }) {
  const [state, setState] = useState<ApproveDeviceState>('idle');
  const [error, setError] = useState<ApproveDeviceProps['error']>(initialError);
  const act = async (approve: boolean) => {
    setState(approve ? 'approving' : 'denying');
    setError(undefined);
    const r = await decide(code, approve);
    if ('error' in r) {
      setState('idle'); // the buttons stay enabled for a retry
      setError(r.error as ApproveDeviceProps['error']);
    } else {
      setState(r.result === 'ok' ? (approve ? 'approved' : 'denied') : r.result);
    }
  };
  return <ApproveDevice code={code} lookup={lookup} state={state} error={error} onApprove={() => void act(true)} onDeny={() => void act(false)} />;
}
```

Refuse framing for the approval page (and, simplest, for every page):

```ts title="next.config.ts"
import type { NextConfig } from 'next';

const config: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default config;
```

## 8. Run the website

```sh
npm run dev
```

Check the hub answers:

```sh
curl -s http://localhost:3000/api/uncage/install.sh | head -3
```

It prints the start of the installer (`#!/usr/bin/env bash`, `# Uncage installer: …`).

## 9. Connect your computer (the user’s side)

Open `http://localhost:3000/uncage`. The chat shows **Connect your computer** with two commands. On a real deployment the user copies both. For this local test:

1. **Install the CLI.** `curl -fsSL http://localhost:3000/api/uncage/install.sh | bash` works, or install it directly: `npm i -g @uncage/cli`.
2. **Connect.** Run the setup command the page shows:

   ```sh
   uncage setup http://localhost:3000
   ```

   It prints a code and opens `http://localhost:3000/device?code=…`. Check that the code matches and click **Approve**. Setup saves the machine token in `~/.uncage/agent.yaml` and starts the background agent (a launchd service).

Back on the chat page, the status changes from “Waiting for your computer…” to **Connected: &lt;your computer’s name&gt;**.

:::tip[Plain http]
The agent accepts `http://` only for `localhost` and `127.0.0.1`. Every other website must use `https://` (the WebSocket then uses `wss://`).
:::

## 10. Send a task

Click the starter prompt, or type: “Write a short poem about this website and save it with save_note”.

- Claude Code runs on your computer, in `~/Uncage/localhost-3000/<session id>/`.
- It calls `mcp__site__save_note`. The handler runs in your Next.js server as `dev-user`.
- The answer streams into the chat. Commands and file edits show **Allow** / **Deny** cards.

Stop the agent (`uncage agent uninstall`, or quit `uncage agent` if you ran it in the foreground) and reload the page: the conversation is still there, because of `sessionStorage: 'site'`, and the composer says the computer is offline.

## What you built

| File | Role |
| --- | --- |
| `lib/auth.ts` | Who is signed in (replace with your auth) |
| `lib/tools.ts` | Your site tools |
| `lib/uncage-hub.ts`, `lib/hub-registry.ts` | Creating the hub, sharing it with pages |
| `server.ts` | One HTTP server: hub API, computer WebSockets, Next.js |
| `app/uncage/page.tsx` | The chat |
| `app/device/*`, `next.config.ts` | The approval page, safely |

The repository’s [`examples/connected-demo`](https://github.com/ptmafia/uncage/tree/main/examples/connected-demo) is the same setup, grown into a full site: sign-in, two tools that create and publish a landing page (pulling the files from the user’s computer), a skill, an assets gallery, and a two-node mode with Redis and Postgres. It is tested end to end against real Claude Code.

## Next

- [Define tools](/uncage/guides/define-tools/): validation, errors, confirmation, the file channel.
- [Write skills](/uncage/guides/write-skills/) and [choose them per run](/uncage/guides/select-manifest/).
- [Auth and device approval](/uncage/guides/auth-and-device-approval/): connect your real sign-in.
- [Multi-node](/uncage/guides/multi-node/): Postgres + Redis behind a load balancer.
