# @uncage/server

The Uncage HTTP layer: `createUncageServer({ uncage, token })` serves the `/v1/*` REST + SSE API over `@uncage/core`, bound to 127.0.0.1 with bearer-token, Host and Origin checks. `@uncage/server/proxy` exports `createUncageHandler()`, a same-origin proxy for Next.js route handlers. It keeps the token server-side, rejects cross-origin requests, and only answers to `allowedHosts` (loopback by default; see the root README's security model).

API: [`src/index.ts`](./src/index.ts) (every export is documented with JSDoc) · Project overview: [README](../../README.md)
