# @uncage/client

Browser transport for Uncage without React: `createUncageClient({ baseUrl = '/api/uncage' })` gives typed REST calls (sessions, runs, approvals, settings, attachments) and `subscribe(sessionId, { after, onEvent, onState, onError })` — an SSE stream that reconnects with `Last-Event-ID` and decodes UTF-8 safely. Errors are `UncageClientError` with `code`, `hint` and `status`. Most apps use it through [`@uncage/react`](https://www.npmjs.com/package/@uncage/react).

---

Part of **Uncage** — bring Claude Code (and Codex) into your own app with approvals, streaming and a ready-made UI. Start with [`@uncage/react-ui`](https://www.npmjs.com/package/@uncage/react-ui) for the 5-minute setup. MIT licensed.
