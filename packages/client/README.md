# @uncage/client

Framework-free browser transport: `createUncageClient({ baseUrl })` wraps the REST API (sessions, runs, approvals, runtimes) and subscribes to a session's event stream with resumable SSE. It reconnects with `Last-Event-ID`, decodes UTF-8 safely across chunks, and reports connection state. It talks to your app's same-origin proxy (`/api/uncage` by default).

API: [`src/index.ts`](./src/index.ts) (every export is documented with JSDoc) · Project overview: [README](../../README.md)
