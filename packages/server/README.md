# @uncage/server

Two things:

1. **`@uncage/server/proxy`** — `createUncageHandler(options?)` returns `{ GET, POST, PATCH }` Fetch-style handlers for your app's `/api/uncage/[...path]` route. It forwards to the local daemon with its token (read from `UNCAGE_TOKEN` or `~/.uncage/token`), so the token never reaches the browser, and it rejects cross-origin requests and non-allowed hosts (DNS rebinding). Options: `endpoint` (env `UNCAGE_URL`, default `http://127.0.0.1:4783`), `token`, `basePath` (default `/api/uncage`), `allowedHosts` (env `UNCAGE_ALLOWED_HOSTS`, default loopback names; the list replaces the default).
   For Express, Connect, Fastify or `node:http`, `createUncageNodeHandler(options?)` is the same proxy as a `(req, res, next?)` handler that streams bodies and SSE: `app.use('/api/uncage', createUncageNodeHandler())` (mount it before body parsers and compression).
2. **`createUncageServer({ uncage, token, port })`** — the daemon itself (REST + SSE over `@uncage/core`, loopback only, bearer token, Host/Origin checks). Most people just run it with `npx uncage serve` from [`@uncage/cli`](https://www.npmjs.com/package/@uncage/cli).

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
