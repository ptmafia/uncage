# Uncage 0.3 — FaaS Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Connected Mode platform-agnostic: the same `@uncage/hub` API runs as a long-running Node process (traditional mode, WebSocket) or on any Fetch platform such as Vercel or Cloudflare Workers (FaaS mode, resumable HTTP streaming plus one Postgres), and the agent picks the transport by itself.

**Architecture:** The hub core becomes Web-standard only (`hub.fetch(Request) → Response`, `crypto.subtle`, `ReadableStream`), with Node-only pieces (`toNodeHandler`, `attachWebSocket`, `pgliteHubStore`) moved to `@uncage/hub/node`. A transport-neutral `MachineHub` serves two links: WebSocket (traditional, unchanged speed) and HTTP streaming (a per-machine durable outbox with monotonic `seq` read through a rotating NDJSON stream, and idempotent batched upstream POSTs deduped in the store). `postgresCluster` (message table + adaptive polling) and store-backed rate limits, leases and tool-call state make every function instance stateless. Tool calls are exactly-once on connection drop and at-most-once on instance kill.

**Tech Stack:** existing monorepo (TS ^6.0.3, Zod 4, Vitest 5, PGlite, `pg`, `ws`, ioredis, Next 16, React 19, Astro Starlight, Playwright with system Chrome), esbuild (web-entry check), wrangler (Cloudflare `wrangler dev` / workerd), Postgres 16 in Docker.

**Spec:** docs/superpowers/specs/2026-11-08-uncage-faas-design.md

## Global Constraints

- Spec §5.9 overrides earlier sections of the spec wherever they differ.
- Breaking changes are allowed; there is no 0.2 compatibility path in the protocol or the hub API (spec §2, §5.9.2).
- Version is 0.3.0 for every `@uncage/*` package (Changesets `fixed` group); no 1.0.
- Hub requires agent >= 0.3: `minAgentVersion` defaults to `'0.3.0'` (`MIN_AGENT_VERSION` in `@uncage/protocol`), `CONNECTED_PROTOCOL = 2`.
- The root `@uncage/hub` entry uses Web-standard APIs only (`Request`/`Response`/`ReadableStream`/`crypto.getRandomValues`/`crypto.subtle`/`TextEncoder`); no `node:*`, `ws`, `Buffer`, `process`, `.unref()` without a guard. `toNodeHandler`, `attachWebSocket(hub, server)` and `pgliteHubStore` live in `@uncage/hub/node`. No conditional exports. A build check fails if the root bundle contains a Node built-in.
- `createHub` requires an explicit `store` (no default PGlite). `Hub` has no `attach`; it has `fetch(req, info?)`.
- FaaS mode needs only Postgres (`DATABASE_URL`); Redis stays optional. Traditional mode needs zero external dependencies (PGlite + memory cluster + WebSocket) and must not get slower or more complex for its users.
- Upstream message bodies and file-pull chunks are ≤ 1 MB (`MAX_HTTP_BODY_BYTES = 1_048_576`; chunks stay 256 KiB raw), fitting Vercel's ~4.5 MB request body limit.
- Adaptive polling: ~300 ms while active, backing off to seconds when idle (defaults `activeMs: 300`, `idleMs: 2_000`, `activeWindowMs: 30_000`); stream duration and polling intervals are configurable. Default server-initiated stream rotation `maxDurationMs: 250_000`.
- Tool execution: exactly-once on connection drop (persisted call state and result, idempotent ids, redelivery); at-most-once on instance kill (the call is marked failed with "Site tool "<name>" timed out on the website. Please try again.", never re-run automatically).
- Event replication, approvals and file pulls neither lose nor duplicate anything across drops, rotations and retries.
- Docs are trilingual (en / zh-CN / ja) and follow `apps/docs/i18n-glossary.md`; `check-i18n` strict, `check-snippets`, link check must pass. Every platform page: prerequisites, complete code, env vars, deploy steps, verification checklist, FAQ.
- A platform is only claimed as supported after a real run on its local runtime: `next build && next start` (no custom server) and `wrangler dev` (workerd), with real Claude Code.
- Never download browsers: Playwright uses `channel: 'chrome'`. Never run the real Codex binary. Never touch the real `~/.uncage` / `~/Uncage`: agents in tests and verification always get a tmp `UNCAGE_HOME` (HOME stays real so Claude Code keeps its login).
- Commits are conventional (`feat(hub): …`, `fix(agent): …`, `docs: …`, `chore: …`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit on `main`; work on `feat/faas-mode`.
- Release prep follows CONTRIBUTING + the user's rule: we prepare `release/0.3.0` (versions, changelogs, pushed); the user only opens/merges the PR.
- Problems hit during execution are written down in the task's commit body and the recommended option is taken without blocking.
- Between Task 2 and Task 15 the help-site snippet check (`check-snippets`) and i18n parity may be red (docs still show the 0.2 API); Task 14 makes `check-snippets` green, Task 15 makes `check-i18n` strict green. `pnpm build && pnpm test && pnpm typecheck && pnpm lint` stay green after every task.

## Review Focus

1. **Out-of-order commit visibility silently drops messages.** Two concurrent writers get `seq`/`id` 10 and 11, 11 commits first, a reader advances its cursor to 11 and never sees 10 (lost command / tool result / cluster message). Applies to `uncage_hub_outbox` and `uncage_cluster_messages`. Pinned in Task 3 (`enqueueOutbox` concurrency on real Postgres) and Task 5 (`postgresCluster delivers a message whose lower id commits after a higher id`).
2. **A tool runs twice, or a killed instance's call is re-run instead of failed.** Connection drops, POST retries, WS reconnect resends and stale leases all hit `claimToolCall`. Pinned in Task 7 (`20 random connection cuts: every handler runs exactly once` and `killed instance: one interrupted error, handler started once`) and Task 8 (real agent).
3. **Cursor/ack mishandling across stream rotation** re-executes a `startRun`/`decide` or skips one: the hub deletes outbox rows the agent never processed, or the agent processes a redelivered `seq` again. Pinned in Task 6 (`stream with cursor n delivers exactly the items > n; reopening with the same cursor redelivers them`) and Task 8 (`cut after delivery before processing: command executed once`).
4. **Upstream retries landing on different instances duplicate or reorder data**: duplicate `file_chunk` corrupts a pull, a batch processed past a `busy` message reorders chunks, duplicate events reach browsers. Pinned in Task 6 (`batch stops at the first busy message`) and Task 7 (`file pull across instances survives a retried POST`).
5. **The root entry silently pulls Node built-ins** (through the `@uncage/core` barrel, the `@uncage/server/wire` re-export of `toNodeHandler`, `Buffer`, `timer.unref()`), so a Workers build fails only at deploy time. Pinned in Task 2 (`check-web-entry` in the hub `build`) and Task 12 (`wrangler deploy --dry-run` of the Cloudflare example).

---

### Task 1: Protocol 0.3 — versioning, transport negotiation and HTTP stream frames

**Files:**
- Modify: `packages/protocol/src/connected.ts`, `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/transport.ts`
- Test: `packages/protocol/src/connected.test.ts`, create `packages/protocol/src/transport.test.ts`
- Modify (minimal, to keep the suite green): `packages/hub/src/machines.ts` (accept protocol 2 hello), `packages/agent/src/site.ts` (send protocol 2 + `transport: 'ws'`), `packages/hub/src/test-utils.ts`, `packages/agent/src/fake-hub.test.ts`

**Interfaces — Produces:**
```ts
// connected.ts
export const CONNECTED_PROTOCOL = 2;
export const MIN_AGENT_VERSION = '0.3.0';
export const TransportKindSchema: z.ZodEnum<['ws', 'http']>; export type TransportKind = 'ws' | 'http';
export const TransportOfferSchema = z.object({ kind: TransportKindSchema, url: z.string() /* ws(s):// or http(s):// */ });
// AgentFrame 'hello' gains: transport: TransportKind
// MachineInfoSchema gains: agentOutdated: z.boolean(), transport: TransportKindSchema.nullable()
// DeviceTokenResponse 'ok' gains: transports: z.array(TransportOfferSchema).min(1)
export const AgentInfoSchema = z.object({ protocol: z.number().int(), minAgentVersion: z.string(), transports: z.array(TransportOfferSchema).min(1) });
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

// transport.ts (HTTP streaming wire)
export const MAX_HTTP_BODY_BYTES = 1_048_576;
export const HTTP_STREAM_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';
export const UPSTREAM_ID = /^up_[A-Za-z0-9_-]{16,64}$/;
/** Agent → hub messages allowed upstream over HTTP (no hello/pong: connect replaces hello, the stream replaces ping/pong). */
export const UpstreamMessageSchema = z.object({ id: z.string().regex(UPSTREAM_ID), msg: AgentFrameSchema /* refined: t ∉ {'hello','pong'} */ });
export const HttpConnectResponseSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('welcome'), machineId: z.string(), protocol: z.number().int(), minAgentVersion: z.string(),
             linkId: z.string().regex(/^lnk_[0-9a-f]{24}$/), cursor: z.number().int().nonnegative(), replies: z.array(HubFrameSchema) }),
  z.object({ t: z.literal('upgrade_required'), minAgentVersion: z.string() }),
]);
export const HttpEventsRequestSchema = z.object({ linkId: z.string(), ack: z.number().int().nonnegative().optional(), busy: z.boolean(), msgs: z.array(UpstreamMessageSchema).max(500) });
export const HttpEventsResponseSchema = z.object({ processed: z.array(z.string()), retry: z.array(z.string()), replies: z.array(HubFrameSchema) });
export const StreamLineSchema = z.union([
  z.object({ seq: z.number().int().positive(), msg: HubFrameSchema }),
  z.object({ ctl: z.enum(['ping', 'rotate', 'replaced', 'revoked']), at: z.number().optional() }),
]);
export type UpstreamMessage, HttpConnectResponse, HttpEventsRequest, HttpEventsResponse, StreamLine; // z.infer of the above
export function parseHttpEventsRequest(raw: string): HttpEventsRequest; // ProtocolFrameError when > MAX_HTTP_BODY_BYTES, deep, not JSON, bad shape
export function parseStreamLine(raw: string): StreamLine;               // same guards, MAX_FRAME_BYTES
```

- [ ] Step: failing tests. In `transport.test.ts`:
  ```ts
  it('accepts a full events batch and rejects a body over MAX_HTTP_BODY_BYTES', () => {
    expect(parseHttpEventsRequest(JSON.stringify({ linkId: 'lnk_' + '0'.repeat(24), busy: false, msgs: [{ id: 'up_' + 'a'.repeat(22), msg: { t: 'events', sessionId: 's', events: [] } }] })).msgs).toHaveLength(1);
    expect(() => parseHttpEventsRequest('x'.repeat(1_048_577))).toThrow(ProtocolFrameError);
  });
  it('refuses hello and pong upstream', () => { /* msg.t 'hello' | 'pong' → ProtocolFrameError */ });
  it('parses outbox and control lines', () => {
    expect(parseStreamLine('{"seq":3,"msg":{"t":"ping","at":1}}')).toEqual({ seq: 3, msg: { t: 'ping', at: 1 } });
    expect(parseStreamLine('{"ctl":"rotate"}')).toEqual({ ctl: 'rotate' });
    expect(() => parseStreamLine('{"seq":0,"msg":{"t":"ping","at":1}}')).toThrow(); // seq starts at 1
  });
  ```
  In `connected.test.ts`: `hello` without `transport` is rejected; `CONNECTED_PROTOCOL === 2`; `MIN_AGENT_VERSION === '0.3.0'`; `AgentInfoSchema` rejects `transports: []`; `DeviceTokenResponseSchema` `ok` requires `transports`.
- [ ] Step: run → FAIL: `pnpm --filter @uncage/protocol exec vitest run src/transport.test.ts src/connected.test.ts`
- [ ] Step: implement the schemas above in `transport.ts`/`connected.ts` (reuse the existing `parseFrame` guards with a size parameter); in `machines.ts` keep the existing `hello.protocol < CONNECTED_PROTOCOL → upgrade_required` rule (now rejects protocol 1); in `site.ts` send `transport: 'ws'`; update fakes/fixtures to protocol 2.
- [ ] Step: run → PASS: `pnpm --filter @uncage/protocol test && pnpm --filter @uncage/hub test && pnpm --filter @uncage/agent test` (all green)
- [ ] Step: commit `feat(protocol)!: protocol 2 with transport negotiation and HTTP stream frames`

---

### Task 2: Hub core on Web standards, `@uncage/hub/node`, explicit store, `hub.fetch`

**Files:**
- Create: `packages/core/src/errors.ts` export path (`@uncage/core/errors`: add tsup entry + `exports["./errors"]` in `packages/core/package.json`)
- Modify: `packages/server/src/wire.ts` (drop the `toNodeHandler` re-export), `packages/server/package.json` + `tsup.config.ts` (add `./node-handler` subpath)
- Create: `packages/hub/src/web.ts`, `packages/hub/src/ids.ts`, `packages/hub/src/node/index.ts`, `packages/hub/src/node/ws.ts`, `packages/hub/scripts/check-web-entry.mjs`
- Modify: `packages/hub/src/{hub.ts,types.ts,index.ts,machines.ts,browser-api.ts,device.ts,files.ts,sse.ts,tools.ts,rate-limit.ts,store/pglite.ts}`; move `packages/hub/src/node.ts` → `packages/hub/src/node/node-handler.ts`
- Modify: `packages/hub/package.json` (`exports["./node"]`, `build: "tsup && node scripts/check-web-entry.mjs"`, devDep `esbuild`), `packages/hub/tsup.config.ts` (entries `src/index.ts`, `src/node/index.ts`)
- Modify call sites: `packages/hub/src/{test-utils.ts,multinode-scenario.ts,hub.test.ts,hardening.test.ts,tools.test.ts}`, `packages/agent/src/test-helpers.ts`, `packages/cli/src/connected.test.ts`, `examples/connected-demo/{server.ts,lib/hub.ts,lib/hub-registry.ts,lib/demo.test.ts,scripts/multinode.ts}`, `apps/site/src/snippets/server.ts`, `apps/docs/astro.config.mjs` (typedoc entry `hub/src/node/index.ts`)
- Test: create `packages/hub/src/web-entry.test.ts`, `packages/hub/src/node/ws.test.ts`

**Interfaces — Consumes:** Task 1 protocol. **Produces:**
```ts
// web.ts
export function sha256Hex(s: string): Promise<string>;            // crypto.subtle
export function randomToken(bytes?: number /*32*/): string;        // base64url
export function randomHex(bytes: number): string;
export function toBase64(b: Uint8Array): string; export function fromBase64(s: string): Uint8Array;
export function utf8Length(s: string): number;
export function unrefTimer(t: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void; // t.unref?.()
// ids.ts — node-routed ids: the reply for a command/pull/upload goes to the node encoded in its id
export function newNodeId(): string;                               // `node_${randomHex(8)}` (16 hex)
export function routedId(prefix: 'cmd' | 'pull' | 'upl', nodeId: string): string; // `${prefix}_${nodeId}_${randomHex(12)}`
export function routeOf(id: string): string | null;                // the node_… part, else null
// types.ts
export interface HubOptions { store: HubStore /* required */; cluster?: ClusterAdapter; /* …existing fields… */ }
export interface Hub {
  readonly basePath: string;
  fetch(req: Request, info?: { clientIp?: string; waitUntil?(p: Promise<unknown>): void }): Promise<Response>;
  approveDevice(…); denyDevice(…); lookupDevice(…); revokeMachine(…); // unchanged
  close(): Promise<void>;                                            // never closes `store`; closes a cluster it created
}
export const HUB_INTERNALS: unique symbol; // Symbol.for('uncage.hub.internals'), used by @uncage/hub/node only
export interface HubInternalsHandle { machines: MachineHub; basePath: string; logger: HubLogger; enableWebSocket(): void; }
// machines.ts — transport-neutral
export interface MachineLink {
  readonly kind: TransportKind; readonly linkId: string; machine: MachineRecord; readonly signal: AbortSignal;
  /** ws: write now; http: `durable` → outbox, otherwise collected into the response's `replies`. */
  send(f: HubFrame, o?: { durable?: boolean }): Promise<void>;
}
export class MachineHub {
  hello(link: MachineLink, hello: Extract<AgentFrame, { t: 'hello' }>): Promise<'ok' | 'upgrade' | 'hub_too_old' | 'revoked'>;
  handleMessage(link: MachineLink, msg: AgentFrame): Promise<void>;
  addLocalLink(link: MachineLink & { close(code: number, reason: string): void }): void; removeLocalLink(link: MachineLink): void;
  command<K extends HubCommandOp>(machineId: string, op: K, args: HubCommandArgs[K]): Promise<HubCommandResults[K]>;
  upload(…); pull(…); isOnline(machineId: string): Promise<boolean>; kick(…); close(): Promise<void>;
}
// @uncage/hub/node
export function toNodeHandler(hub: Hub): UncageNodeHandler;
export function attachWebSocket(hub: Hub, server: import('node:http').Server, o?: { path?: string /* `${basePath}/agent` */ }): () => void; // returns detach
export function pgliteHubStore(o: { dataDir: string }): Promise<HubStore>;
```
- [ ] Step: failing tests.
  ```ts
  // web-entry.test.ts
  it('createHub refuses to start without a store', async () => {
    await expect(createHub({ publicUrl: 'https://a.example', getUser: async () => null } as HubOptions)).rejects.toThrow(/store is required/);
  });
  it('createHub starts no timers (FaaS instances must not keep background work)', async () => {
    vi.useFakeTimers(); const hub = await createHub({ publicUrl: 'https://a.example', getUser: async () => null, store });
    expect(vi.getTimerCount()).toBe(0); await hub.close();
  });
  it('hub.fetch serves the public install script without any Node handler', async () => {
    const res = await hub.fetch(new Request('https://a.example/api/uncage/install.sh'));
    expect(res.status).toBe(200); expect(await res.text()).toContain('@uncage/cli@^0.3');
  });
  it('the root bundle contains no Node built-ins', () => {
    const r = spawnSync(process.execPath, ['scripts/check-web-entry.mjs'], { cwd: pkgDir, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0); // Review Focus #5
  });
  // node/ws.test.ts
  it('attachWebSocket accepts a machine; the detach function stops new upgrades', async () => { /* hello → welcome; after detach a new dial gets ECONNRESET/404 */ });
  ```
  `check-web-entry.mjs`: esbuild bundles `dist/index.js` with `platform: 'neutral'`, `conditions: ['workerd', 'worker', 'browser', 'import']`, `mainFields: ['module', 'main']`, `external: ['pg', 'ioredis']`, `metafile: true`; exits 1 listing offenders if any import is `node:*` or in `module.builtinModules`, or the output matches `/\bBuffer\.|\bprocess\.|\brequire\(/`.
- [ ] Step: run → FAIL: `pnpm --filter @uncage/hub build; pnpm --filter @uncage/hub exec vitest run src/web-entry.test.ts src/node/ws.test.ts`
- [ ] Step: implement. Hub imports `UncageError` from `@uncage/core/errors` and wire helpers from the web-only `@uncage/server/wire`; replace `node:crypto`/`Buffer`/`posix` with `web.ts` (`posix.normalize` → a small segment normalizer in `hub.ts` with the same refusals); `sha256` call sites become `await sha256Hex`. Split `MachineHub`: the WebSocket server, heartbeat timers, close codes and `rawToString` move to `node/ws.ts`, which builds a `MachineLink` per socket and calls `hello`/`handleMessage`; command/pull/upload ids use `routedId` and replies route by `routeOf` (keep the per-link in-flight map for fast `machine_offline` on WS close). The node-channel cluster subscription is permanent once `enableWebSocket()` ran, otherwise taken only while a command/pull/upload is pending (refcounted). Remove the hourly `setInterval` sweep from `createHub` (Task 4 replaces it). `hub.handler` → `hub.fetch`. Migrate every call site listed above to `store` + `@uncage/hub/node`.
- [ ] Step: run → PASS: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` (all green; docs snippet check excepted, see Global Constraints)
- [ ] Step: commit `feat(hub)!: Web-standard core with hub.fetch; Node parts move to @uncage/hub/node; store is required`

---

### Task 3: Store — links, durable outbox, inbox dedupe, tool-call state, shared counters

**Files:**
- Modify: `packages/hub/src/store/store.ts`, `packages/hub/src/store/sql.ts` (migration 7), `packages/hub/src/store/postgres.ts` (once-per-isolate migration fast path), `packages/hub/src/store/contract.ts`
- Test: `packages/hub/src/store/store.test.ts` (PGlite), `packages/hub/src/real-services.docker.test.ts` (contract runs on Postgres 16 already; add the concurrency test)

**Interfaces — Produces** (`HubStore` additions/changes; all ISO strings unless `…Ms`):
```ts
export interface OutboxItem { seq: number; msgId: string; msg: HubFrame; expiresAt: string }
export type ToolResultFrame = Extract<HubFrame, { t: 'tool_result' }>;
export type ToolCallStatus = 'running' | 'ok' | 'error' | 'invalid' | 'timeout' | 'cancelled' | 'interrupted';
export interface ToolCallRecord { /* existing */ leaseUntil?: string; result?: ToolResultFrame }
export type ToolCallClaim = { kind: 'new' } | { kind: 'running' } | { kind: 'stale'; record: ToolCallRecord } | { kind: 'done'; record: ToolCallRecord & { result: ToolResultFrame } };
export interface MachineRecord { /* existing */ outdatedAt?: string }

openLink(machineId: string, l: { linkId: string; transport: TransportKind; at: string }): Promise<{ ackedSeq: number }>; // upsert, replaces the current link
pollLink(machineId: string, linkId: string, o: { after: number; limit: number; now: string }): Promise<{ state: 'current' | 'replaced' | 'gone'; busy: boolean; items: OutboxItem[] }>;
updateLink(machineId: string, linkId: string, p: { ackedSeq?: number; busy?: boolean; at: string }): Promise<'current' | 'replaced' | 'gone'>; // ackedSeq only moves forward and deletes outbox rows seq <= ackedSeq
closeLink(machineId: string, linkId: string | null): Promise<void>; // null: whichever link is current
enqueueOutbox(machineId: string, items: Array<{ msgId: string; msg: HubFrame; expiresAt: string }>): Promise<number[]>; // per-machine monotonic seqs, gap-free in commit order
claimInbox(machineId: string, msgIds: string[], o: { leaseUntil: string; now: string }): Promise<Record<string, 'new' | 'done' | 'busy'>>; // expired 'processing' → 'new'
completeInbox(machineId: string, msgIds: string[], at: string): Promise<void>;
claimToolCall(r: ToolCallRecord, o: { leaseUntil: string; now: string }): Promise<ToolCallClaim>; // keyed by (machineId, callId)
finishToolCall(id: string, r: ToolCallFinish & { result: ToolResultFrame }): Promise<boolean>; // CAS: only while status = 'running'
listStaleToolCalls(now: string, limit: number): Promise<ToolCallRecord[]>; // running with leaseUntil < now
hitRateLimit(key: string, o: { max: number; windowMs: number; nowMs: number }): Promise<{ allowed: boolean; retryAfterMs: number }>; // fixed window, atomic
releaseRateLimit(key: string, o: { windowMs: number; nowMs: number }): Promise<void>;
recordDevicePoll(deviceCodeHash: string, at: string): Promise<string | null>; // previous poll time
tryLease(name: string, o: { holder: string; until: string; now: string }): Promise<boolean>;
pruneTransport(o: { now: string; inboxBefore: string; rateLimitBeforeMs: number }): Promise<{ outbox: number; inbox: number; rateLimits: number; deviceCodes: number }>;
markMachineOutdated(id: string, at: string): Promise<void>;
// deleteMachine also deletes its link, outbox and inbox rows
```
Migration 7 (exact table names): `uncage_hub_links (machine_id text PRIMARY KEY, link_id text NOT NULL, transport text NOT NULL, next_seq bigint NOT NULL DEFAULT 0, acked_seq bigint NOT NULL DEFAULT 0, busy boolean NOT NULL DEFAULT false, updated_at text NOT NULL)`; `uncage_hub_outbox (machine_id text, seq bigint, msg_id text NOT NULL, msg jsonb NOT NULL, expires_at text NOT NULL, created_at text NOT NULL, PRIMARY KEY (machine_id, seq))`; `uncage_hub_inbox (machine_id text, msg_id text, state text NOT NULL, lease_until text NOT NULL, updated_at text NOT NULL, PRIMARY KEY (machine_id, msg_id))`; `uncage_hub_rate_limits (key text, window_start bigint, count integer NOT NULL, PRIMARY KEY (key, window_start))`; `uncage_hub_leases (name text PRIMARY KEY, holder text NOT NULL, until text NOT NULL)`; `ALTER TABLE uncage_hub_tool_calls ADD result jsonb, ADD lease_until text` + `CREATE UNIQUE INDEX uncage_hub_tool_calls_call_idx ON uncage_hub_tool_calls (machine_id, call_id)`; `ALTER TABLE uncage_hub_device_codes ADD last_poll_at text`; `ALTER TABLE uncage_hub_machines ADD outdated_at text`.

- [ ] Step: failing contract tests in `contract.ts` (run on PGlite and, in the docker project, Postgres 16):
  ```ts
  it('outbox: seqs are per machine, monotonic, ack deletes and only moves forward', async () => {
    await store.openLink('m1', { linkId: 'lnk_a', transport: 'http', at });
    expect(await store.enqueueOutbox('m1', [item('x'), item('y')])).toEqual([1, 2]);
    expect(await store.enqueueOutbox('m2', [item('z')])).toEqual([1]);
    expect((await store.pollLink('m1', 'lnk_a', { after: 0, limit: 10, now })).items.map((i) => i.msgId)).toEqual(['x', 'y']);
    await store.updateLink('m1', 'lnk_a', { ackedSeq: 1, at }); await store.updateLink('m1', 'lnk_a', { ackedSeq: 0, at });
    expect((await store.pollLink('m1', 'lnk_a', { after: 0, limit: 10, now })).items.map((i) => i.seq)).toEqual([2]);
  });
  it('outbox: expired items are not returned; a replaced link reports replaced; a deleted machine reports gone', …);
  it('inbox: new → busy while leased → new after lease expiry → done after complete', …);
  it('tool calls: new, running, stale after lease, done with the stored result; finish is CAS on running', async () => {
    expect(await store.claimToolCall(rec, { leaseUntil: t(10), now: t(0) })).toEqual({ kind: 'new' });
    expect(await store.claimToolCall(rec, { leaseUntil: t(20), now: t(5) })).toEqual({ kind: 'running' });
    expect((await store.claimToolCall(rec, { leaseUntil: t(30), now: t(11) })).kind).toBe('stale');
    expect(await store.finishToolCall(rec.id, { ...interrupted, result })).toBe(true);
    expect(await store.finishToolCall(rec.id, { ...ok, result })).toBe(false);
    expect(await store.claimToolCall(rec, { leaseUntil: t(40), now: t(12) })).toMatchObject({ kind: 'done', record: { status: 'interrupted', result } });
  });
  it('rate limits: atomic under 20 parallel hits (exactly max allowed), release gives one back, new window resets', …);
  it('leases: one holder at a time; expired lease can be taken', …);
  it('recordDevicePoll returns the previous poll time', …);
  ```
  In `real-services.docker.test.ts` (Review Focus #1):
  ```ts
  it('enqueueOutbox under 50 concurrent writers: a reader advancing its cursor sees every item exactly once', async () => {
    // 50 parallel enqueueOutbox('m', [item(i)]) on separate pool connections while a loop polls after=cursor and sets cursor=max(seq)
    expect(new Set(seen).size).toBe(50); expect(seen).toHaveLength(50);
  });
  ```
- [ ] Step: run → FAIL: `pnpm --filter @uncage/hub exec vitest run src/store` and `UNCAGE_DOCKER_TESTS=1 pnpm --filter @uncage/hub exec vitest run --project docker`
- [ ] Step: implement in `sql.ts`; `enqueueOutbox` allocates seqs in the same transaction with `UPDATE uncage_hub_links SET next_seq = next_seq + $n … RETURNING next_seq` (row lock serializes writers per machine, so commit order = seq order; insert a link row with `link_id = ''` if none); `hitRateLimit` is one `INSERT … ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count` (over `max` → decrement and refuse). `postgresHubStore` skips the advisory-lock migration when a module-level memo says this pool/connection string is at `HUB_MIGRATIONS.at(-1).id` or a fast `SELECT max(id)` confirms it.
- [ ] Step: run → PASS (both commands above, all green)
- [ ] Step: commit `feat(hub): store links, durable outbox, inbox dedupe, tool-call leases and shared counters`

---

### Task 4: Shared rate limits and opportunistic maintenance with a lease

**Files:**
- Modify: `packages/hub/src/rate-limit.ts` (replace `SlidingWindow` with a store limiter), `packages/hub/src/device.ts`, `packages/hub/src/hub.ts`, `packages/hub/src/types.ts`, `packages/hub/src/browser-api.ts`
- Create: `packages/hub/src/maintenance.ts`
- Modify: `packages/hub/src/node/ws.ts` (traditional mode: `attachWebSocket` runs `maintain()` every `intervalMs` with an unref'd timer)
- Test: `packages/hub/src/hardening.test.ts`, create `packages/hub/src/maintenance.test.ts`

**Interfaces — Consumes:** Task 3 store. **Produces:**
```ts
export interface RateLimiter { take(key: string): Promise<void> /* throws rate_limited with details.retryAfterSec */; release(key: string): Promise<void> }
export function storeRateLimiter(store: HubStore, o: { name: string; max: number; windowMs: number; now?: () => number }): RateLimiter; // key = `${name}:${key}`
// HubOptions additions
maintenance?: { intervalMs?: number /* 60_000 */; secret?: string /* enables GET|POST <base>/maintenance with Authorization: Bearer <secret> (matches Vercel Cron's CRON_SECRET) */; onRun?(): Promise<void> };
// Hub addition
maintain(): Promise<MaintenanceReport>;
export interface MaintenanceReport { ran: boolean; pruned: Record<string, number>; interruptedToolCalls: number }
// maintenance.ts
export function maintenance(d: { store: HubStore; nodeId: string; intervalMs: number; logger: HubLogger; tasks: Array<() => Promise<Record<string, number>>>; onRun?: () => Promise<void> }): { maybeRun(waitUntil?: (p: Promise<unknown>) => void): Promise<void>; runNow(): Promise<MaintenanceReport> };
```
- [ ] Step: failing tests.
  ```ts
  it('device-code limits are shared by two hub instances on one store', async () => {
    const [a, b] = await twoHubs({ rateLimits: { deviceCodesPerMinute: 2 } });
    expect((await code(a)).status).toBe(200); expect((await code(b)).status).toBe(200);
    const third = await code(a); expect(third.status).toBe(429); expect((await third.json()).error.details.retryAfterSec).toBeGreaterThan(0);
  });
  it('user-code guessing is shared across instances (userCodeFailures 3 over A,B,A then 429 on B)', …);
  it('slow_down applies across instances (poll on A then immediately on B → slow_down)', …);
  it('maintenance runs at most once per interval across instances (lease) and calls onRun', async () => {
    // two hubs, intervalMs 1000, 20 requests spread over both within 1 s → onRun called once
  });
  it('GET /maintenance needs the secret: 404 without maintenance.secret, 401 with a wrong token, 200 + report with the right one', …);
  it('maintenance prunes expired outbox rows, done inbox rows older than a day, old rate-limit windows, unbound manifests and old attachments', …);
  ```
- [ ] Step: run → FAIL: `pnpm --filter @uncage/hub exec vitest run src/hardening.test.ts src/maintenance.test.ts`
- [ ] Step: implement: device flow uses `storeRateLimiter` for `deviceCodesPerMinute` (`name: 'device_code'`) and `userCodeFailures` (`name: 'user_code'`), `recordDevicePoll` replaces the in-memory `lastPoll`; `hub.fetch` calls `maybeRun(info?.waitUntil)` (per-instance memo `lastAttemptAt`; when due, `tryLease('uncage:maintenance', { holder: nodeId, until: now + intervalMs })`; with `waitUntil` it runs in the background, otherwise it is awaited before routing); tasks = `pruneRunManifests`, `pruneAttachments`, `pruneTransport` (inbox done older than 24 h), and (Task 7 adds) stale tool calls. Update `HubOptions.rateLimits` docs: limits are shared through the store.
- [ ] Step: run → PASS: `pnpm --filter @uncage/hub test` (all green)
- [ ] Step: commit `feat(hub): rate limits and abuse counters shared through the store; opportunistic maintenance with a lease and a cron endpoint`

---

### Task 5: `postgresCluster`

**Files:**
- Create: `packages/hub/src/cluster/postgres.ts`
- Modify: `packages/hub/src/index.ts`, `packages/hub/src/cluster/contract.ts` (add a gap case hook), `packages/hub/src/multinode.test.ts`, `packages/hub/src/real-services.docker.test.ts`
- Test: those files

**Interfaces — Produces:**
```ts
export interface PostgresClusterOptions {
  activePollMs?: number;     // 300
  idlePollMs?: number;       // 2_000
  activeWindowMs?: number;   // 30_000 — after a delivered/published message, poll fast this long
  gapTimeoutMs?: number;     // 2_000 — how long a missing id is waited for before it is skipped
  retentionMs?: number;      // 60_000 — messages older than this are deleted (by any instance, every 30 s)
  onError?(err: Error): void;
}
export function postgresCluster(o: ({ connectionString: string } | { pool: PgPoolLike }) & PostgresClusterOptions): ClusterAdapter;
export function sqlCluster(db: SqlClient, o?: PostgresClusterOptions & { close?: () => Promise<void> }): ClusterAdapter; // PGlite in unit tests
export const CLUSTER_MIGRATIONS: readonly { id: number; sql: string }[];
```
Tables: `uncage_cluster_migrations (id integer PRIMARY KEY)`, `uncage_cluster_messages (id bigserial PRIMARY KEY, channel text NOT NULL, msg text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())` + index `(channel, id)`, `uncage_cluster_presence (machine_id text PRIMARY KEY, node_id text NOT NULL, expires_at timestamptz NOT NULL)`. Presence and retention use the database clock (`now()`).

Poll algorithm (the tests do not determine it): one loop per adapter, running only while ≥ 1 subscription exists; query `SELECT id, channel, msg FROM uncage_cluster_messages WHERE id > $low AND channel = ANY($channels) ORDER BY id`; deliver ids not yet in `seen`; `low` advances to the highest id such that every id ≤ it was seen or has been missing for longer than `gapTimeoutMs`; interval = `activePollMs` within `activeWindowMs` of the last activity, otherwise doubling up to `idlePollMs`; a local `publish` counts as activity and triggers an immediate poll. A new subscription starts after the current max id.

- [ ] Step: failing tests.
  ```ts
  it('sqlCluster on one PGlite meets the ClusterAdapter contract', () => clusterContract(() => sqlCluster(sharedPglite)));
  it('two-node scenario over sqlCluster + PGlite store', () => runMultiNodeScenario({ clusterA, clusterB, store }), 30_000);
  it('backs off to idlePollMs when quiet and returns to activePollMs on traffic', async () => { /* count queries via a wrapped SqlClient over 3 s idle: ≤ 3; during traffic: ≥ 5/s */ });
  // docker (Review Focus #1)
  it('postgresCluster meets the contract on Postgres 16', …);
  it('delivers a message whose lower id commits after a higher id', async () => {
    const tx = await admin.connect(); await tx.query('BEGIN'); await tx.query(`INSERT INTO uncage_cluster_messages (channel, msg) VALUES ('c', 'late')`);
    await a.publish('c', 'early'); await until(() => got.includes('early'));
    await tx.query('COMMIT'); await until(() => got.includes('late'), 2_000);
  });
  ```
- [ ] Step: run → FAIL: `pnpm --filter @uncage/hub exec vitest run src/multinode.test.ts` and the docker project command from Task 3
- [ ] Step: implement `sqlCluster` (migrations under `pg_advisory_lock`, once per isolate like the store) and `postgresCluster` as a `pg.Pool` wrapper (dynamic `import('pg')` for `{ connectionString }`, `watchPoolErrors`).
- [ ] Step: run → PASS (both, all green)
- [ ] Step: commit `feat(hub): postgresCluster — cross-instance messages and presence on Postgres with adaptive polling`

---

### Task 6: HTTP streaming transport in the hub

**Files:**
- Create: `packages/hub/src/http-transport.ts`
- Modify: `packages/hub/src/{hub.ts,machines.ts,browser-api.ts,types.ts,device.ts}`, `packages/hub/src/node/ws.ts` (`enableWebSocket()` marks `ws` as offered)
- Modify: `packages/hub/src/test-utils.ts` (add `startFaasHubs`, `connectFakeHttpAgent`, `killable`)
- Test: create `packages/hub/src/http-transport.test.ts`

**Interfaces — Consumes:** Tasks 1–5. **Produces:**
Routes under `basePath` (machine routes authenticate `Authorization: Bearer <machineToken>`):
- `GET /agent/info` (public) → `AgentInfo`; `transports` = `ws` (`wss://…/agent`, only when `attachWebSocket` ran in this process or `HubOptions.transports` includes it) + `http` (`https://…/agent`).
- `GET /agent` with `Upgrade: websocket` reaching `fetch` (nobody upgraded it: a FaaS deployment) → 426 `upgrade_required`, message `This website needs Uncage agent 0.3.0 or newer. On this computer run: npm i -g @uncage/cli@latest`, and `markMachineOutdated` when the token is valid.
- `POST /agent/connect` body = `hello` (with `transport: 'http'`) → `HttpConnectResponse` (`upgrade_required` with status 426; 401 bad token). Runs `MachineHub.hello`, `openLink`, presence `'http'`, site-mode acks into `replies`.
- `GET /agent/stream?link=<linkId>&cursor=<n>` → `200` NDJSON (`HTTP_STREAM_CONTENT_TYPE`, `cache-control: no-cache, no-transform`, `x-accel-buffering: no`): `updateLink(ackedSeq = cursor)`, then lines `{seq,msg}` for outbox items `> cursor`; `{"ctl":"ping","at"}` every `heartbeat.pingIntervalMs` (refreshes presence `'http'` and `lastSeenAt`); ends with `{"ctl":"rotate"}` at `stream.maxDurationMs`, `{"ctl":"replaced"}` / `{"ctl":"revoked"}` when `pollLink` says `replaced` / `gone`.
- `POST /agent/events` body `HttpEventsRequest` (≤ `MAX_HTTP_BODY_BYTES`, else 400) → `HttpEventsResponse`. `ack`/`busy` → `updateLink`; messages processed strictly in order, deduped with `claimInbox` (`done` → listed in `processed` without reprocessing; the first `busy` stops processing and it and all later ids go to `retry`); `link_replaced` → 400 `invalid_request` with `details.reason: 'link_replaced'`.
- `POST /agent/disconnect` body `{ linkId }` → 204, `closeLink` + clear presence.
```ts
// HubOptions additions
transports?: TransportKind[];
stream?: { maxDurationMs?: number /* 250_000, agent stream and browser SSE */ };
polling?: { activeMs?: number /* 300 */; idleMs?: number /* 2_000 */; activeWindowMs?: number /* 30_000 */ };
// machines.ts
export const HTTP_PRESENCE = 'http';
export const machineChannel = (machineId: string): string => `uncage:machine:${machineId}`; // 'wake' after enqueue
// MachineHub.command / upload / pull: presence === HTTP_PRESENCE → enqueueOutbox (expiresAt: command/upload now + commandTimeoutMs, file_pull now + 30_000) + publish machineChannel 'wake'; the result arrives on any instance and is routed with routeOf(id).
// MachineInfo: agentOutdated = (outdatedAt > lastSeenAt) || agentVersion < minAgentVersion; transport from the link row (null when offline)
```
Test harness (`test-utils.ts`, also copied into `packages/agent/src/test-helpers.ts` for Task 8):
```ts
export interface FaasHubs {
  hubs: Hub[]; stores: HubStore[]; origin: string; api: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;               // raw request to the next instance
  as(user: string, path: string, init?: RequestInit): Promise<Response>;    // browser request as `user`
  pair(user: string): Promise<{ machineId: string; token: string }>;
  route(pick: (req: Request, n: number) => number): void;                    // default round-robin
  cutAll(): void;                                                            // destroy every open socket (connection drop)
  kill(i: number): void;                                                     // stop routing to i, cut its sockets, freeze its killable store/cluster
  close(): Promise<void>;
}
export function startFaasHubs(o: { n: number; makeStore?: () => Promise<HubStore>; makeCluster?: () => ClusterAdapter } & Partial<HubOptions> & HubInternals): Promise<FaasHubs>; // one node:http server, toNodeHandler per instance
export function killable<T extends object>(target: T): { value: T; kill(): void }; // after kill() every method returns a never-settling promise
export function connectFakeHttpAgent(o: { hubs: FaasHubs; token: string; onCommand: CommandHandler }): Promise<FakeHttpAgent>; // callTool(tool, args), events(sessionId, events), close()
```
Stream polling interval: `polling.activeMs` while an item was delivered within `activeWindowMs` or the link is `busy`, otherwise doubling up to `polling.idleMs`; a `machineChannel` wake polls at once.

- [ ] Step: failing tests (fake HTTP agent against `startFaasHubs({ n: 3 })`, every request routed round-robin):
  ```ts
  it('connect → stream → command on another instance → result on a third instance', async () => {
    const agent = await connectFakeHttpAgent({ hubs, token, onCommand: fm.handler });
    expect((await hubs.as('u1', '/sessions', { method: 'POST', body: '{"runtime":"fake"}' })).status).toBe(201);
  });
  it('stream with cursor n delivers exactly the items > n; reopening with the same cursor redelivers them', …); // Review Focus #3
  it('rotates at stream.maxDurationMs with a rotate line; nothing is lost across 5 rotations of 200 ms', …);
  it('batch stops at the first busy message: later messages are returned in retry, unprocessed', …); // Review Focus #4
  it('duplicate upstream ids are listed as processed and not applied twice (events published once)', …);
  it('a body over 1 MB is refused with 400', …);
  it('/agent/info offers http only without attachWebSocket and ws+http with it', …);
  it('a 0.2-style WebSocket upgrade reaching fetch gets 426 upgrade_required and the machine shows agentOutdated', async () => {
    const res = await hubs.fetch('/agent', { headers: { upgrade: 'websocket', connection: 'Upgrade', authorization: `Bearer ${token}` } });
    expect(res.status).toBe(426); expect((await res.json()).error.code).toBe('upgrade_required');
    expect((await (await hubs.as('u1', '/machines')).json())[0].agentOutdated).toBe(true);
  });
  it('protocol 1 hello on /agent/connect gets upgrade_required (426)', …);
  it('machine shows online while streaming and offline within presence TTL after the stream stops', …);
  it('revoke ends the stream with ctl revoked; a second connect ends the first stream with ctl replaced', …);
  it('idle stream polls the outbox at most every idleMs; busy stream every activeMs', …);
  ```
- [ ] Step: run → FAIL: `pnpm --filter @uncage/hub exec vitest run src/http-transport.test.ts`
- [ ] Step: implement `httpTransport(ctx): { handle(req: Request, url: URL, path: string): Promise<Response | null> }` in `http-transport.ts`, mounted by `hub.fetch` before the browser API; the per-request HTTP `MachineLink` collects non-durable frames into `replies` and writes durable ones with `enqueueOutbox`; `/device/token` `ok` includes `transports`.
- [ ] Step: run → PASS: `pnpm --filter @uncage/hub test` (all green)
- [ ] Step: commit `feat(hub): HTTP streaming transport with a durable per-machine outbox, cursor resume and adaptive polling`

---

### Task 7: Tool calls exactly-once / at-most-once and file pulls across instances

**Files:**
- Create: `packages/hub/src/tool-calls.ts` (extracted from `runToolCall` in `hub.ts`)
- Modify: `packages/hub/src/{hub.ts,machines.ts,files.ts,tools.ts,maintenance.ts,http-transport.ts,types.ts}`
- Test: `packages/hub/src/tools.test.ts`, create `packages/hub/src/exactly-once.test.ts`

**Interfaces — Consumes:** Tasks 3, 6. **Produces:**
```ts
export const TOOL_INTERRUPTED_MESSAGE = (tool: string) => `Site tool "${tool}" timed out on the website. Please try again.`; // error code tool_failed, details.reason 'interrupted'
export function toolCalls(d: { store: HubStore; machines: MachineHub; cluster: ClusterAdapter; executor: ToolExecutor; tools: Map<string, ToolSpec>;
  toolTimeoutMs: number; leaseGraceMs: number /* HubInternals.toolLeaseGraceMs, default 10_000 */; runIndexWaitMs: number; logger: HubLogger }): {
  /** Claims, executes (once), stores and delivers the result. Resolves the tool_result to reply on the calling link, or null (running elsewhere: agent retries). */
  handle(machine: MachineRecord, call: Extract<AgentFrame, { t: 'tool_call' }>): Promise<ToolResultFrame | null>;
  interruptStale(): Promise<number>; // maintenance task: listStaleToolCalls → finishToolCall(status 'interrupted', TOOL_INTERRUPTED_MESSAGE) → deliver
};
// MachineHub addition — durable delivery to wherever the machine is: local ws link, the ws node via cluster {k:'deliver'}, or the outbox (http)
deliver(machineId: string, frame: HubFrame, o?: { expiresInMs?: number /* 600_000 */ }): Promise<void>;
```
Rules: lease = `toolTimeoutMs + leaseGraceMs`; claim `done` → reply the stored result; `running` → reply nothing (HTTP: the message id goes to `retry`); `stale` → interrupt as above; a connection drop no longer aborts the handler (`ToolContext.signal` aborts on timeout or run end only; run end is detected by subscribing to `sessionChannel(sessionId)` for the call's lifetime, so it works across instances). `PullAssembler` ignores an exact duplicate `file_chunk` (`seq < next`, same data) and still refuses gaps. File-pull frames arriving on any instance are forwarded to `routeOf(pullId)` as `{k:'pull', id, frame}`. The per-connection concurrency cap becomes per machine per instance.

- [ ] Step: failing tests (`exactly-once.test.ts`, fake HTTP agent over `startFaasHubs({ n: 3 })`, and the fake WS agent for the WS cases):
  ```ts
  it('20 random connection cuts: every handler runs exactly once and every call gets exactly one result', async () => { // Review Focus #2
    const runs = new Map<number, number>(); // handler invocations per args.i
    const cutter = setInterval(() => hubs.cutAll(), 150);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => agent.callTool('count_me', { i })));
    clearInterval(cutter);
    expect([...runs.values()].every((n) => n === 1)).toBe(true); expect(runs.size).toBe(20); expect(results.every((r) => r.ok)).toBe(true);
  });
  it('killed instance: one interrupted error, handler started once, no late result', async () => { // Review Focus #2
    // hubs.kill(0) while instance 0 runs a never-resolving handler (killable store + cluster: every call hangs after kill)
    expect(result).toMatchObject({ ok: false, error: { code: 'tool_failed', message: 'Site tool "slow" timed out on the website. Please try again.', details: { reason: 'interrupted' } } });
    expect(started).toBe(1); expect(await store.listToolCalls(sessionId)).toMatchObject([{ status: 'interrupted' }]);
  });
  it('WS: the agent resends a pending tool_call after reconnecting and gets the stored result', …);
  it('stale running call is interrupted by maintenance and the error is delivered to the machine', …);
  it('file pull across instances survives a retried POST (duplicate chunk ignored, bytes intact)', …); // Review Focus #4
  it('run end on another instance aborts the handler signal', …);
  it('approvals: decide retried after a cut reaches the machine once (same idempotency key)', …);
  ```
  Update `tools.test.ts`: “drops a pending call when its run ends” stays; the disconnect case now expects the handler to finish and the result to be delivered after reconnect.
- [ ] Step: run → FAIL: `pnpm --filter @uncage/hub exec vitest run src/exactly-once.test.ts src/tools.test.ts`
- [ ] Step: implement `toolCalls` and `deliver` as specified; WS and HTTP both call `toolCalls.handle`; register `interruptStale` as a maintenance task.
- [ ] Step: run → PASS: `pnpm --filter @uncage/hub test` (all green)
- [ ] Step: commit `feat(hub): exactly-once site tool calls on connection drop, at-most-once on instance kill; file pulls across instances`

---

### Task 8: Agent — transport negotiation, HTTP stream client, fallback

**Files:**
- Create: `packages/agent/src/transport/types.ts`, `packages/agent/src/transport/ws.ts`, `packages/agent/src/transport/http.ts`, `packages/agent/src/transport/choose.ts`
- Modify: `packages/agent/src/{site.ts,device.ts,agent.ts,index.ts,test-helpers.ts}`, `packages/cli/src/{doctor.ts,setup.ts}`
- Test: create `packages/agent/src/transport.test.ts`, `packages/agent/src/faas.test.ts`; modify `packages/agent/src/agent.test.ts`, `packages/cli/src/doctor.test.ts`

**Interfaces — Consumes:** Tasks 1, 6, 7. **Produces:**
```ts
// transport/types.ts
export type LinkEnd = { welcomed: boolean; upMs: number; stop?: 'revoked' | 'replaced' | 'upgrade'; minAgentVersion?: string };
export interface AgentLink {
  readonly kind: TransportKind;
  /** ws: written to the socket; http: listed in `processed` by the hub (retried with the same up_ id until then). */
  send(f: AgentFrame): Promise<void>;
  readonly ended: Promise<LinkEnd>;
  close(): void;
}
export interface DialOptions {
  hubUrl: string; token: string; hello: Omit<Extract<AgentFrame, { t: 'hello' }>, 'transport'>;
  onWelcome(w: { machineId: string; replies: HubFrame[] }): void; onFrame(f: HubFrame): void;
  cursor: { get(): number; set(seq: number): void };   // http: highest outbox seq dispatched, process lifetime
  busy(): boolean;                                       // a run in progress or a tool call pending
  timing: AgentTiming; fetch: typeof fetch; logger: AgentLogger;
}
export function dialWs(o: DialOptions): AgentLink;
export function dialHttp(o: DialOptions): AgentLink;
// transport/choose.ts
export function fetchAgentInfo(fetchFn: typeof fetch, hubUrl: string): Promise<AgentInfo | null>;
export function chooseTransport(info: AgentInfo | null, s: { wsFailures: number; fellBackAt?: number; now: number }, t: Pick<AgentTiming, 'wsFallbackAfter' | 'wsReprobeMs'>): TransportKind;
// AgentTiming additions / changes
wsFallbackAfter: number;   // 3 consecutive WS attempts that never welcomed or lasted < stableMs
wsReprobeMs: number;       // 1_800_000
httpRetryMaxMs: number;    // 10_000 (upstream retry backoff 500 ms doubling)
toolTimeoutMs: number;     // default 150_000 (> hub lease 120_000 + 10_000)
// SiteAgent
get transport(): TransportKind | null;
```
HTTP client rules: `POST /agent/connect` once per link; every `rotate` line is logged at info as `http stream rotated` (the e2e specs count it); stream reconnects reuse `linkId` with `cursor.get()`; after a stream that delivered at least one line ends without `rotate`, reconnect immediately, otherwise use `backoffDelay`; a `seq <= cursor` is skipped; `cursor` advances when a frame is dispatched and is sent as `ack` on the next POST; upstream is one serialized queue packed into bodies ≤ `MAX_HTTP_BODY_BYTES`, except each `tool_call` goes in its own parallel POST; `retry` ids are re-sent after backoff; 401 → `revoked`, 400 `link_replaced` → `replaced`, 426 → `upgrade`. Common rules (both transports): pending tool calls are not rejected on disconnect and their `tool_call` is re-sent (same id) after every welcome; commands are deduped by id (LRU of 1000, the cached `result` frame is re-sent); a `tool_result` for an unknown id is ignored.

- [ ] Step: failing tests.
  ```ts
  it('chooseTransport: ws when offered; http when only http; http after 3 ws failures; ws again after wsReprobeMs', () => {
    expect(chooseTransport(info(['ws', 'http']), { wsFailures: 0, now }, t)).toBe('ws');
    expect(chooseTransport(info(['http']), { wsFailures: 0, now }, t)).toBe('http');
    expect(chooseTransport(info(['ws', 'http']), { wsFailures: 3, fellBackAt: now, now }, t)).toBe('http');
    expect(chooseTransport(info(['ws', 'http']), { wsFailures: 3, fellBackAt: now, now: now + 1_800_000 }, t)).toBe('ws');
  });
  // faas.test.ts — real SiteAgent with the fake adapter against startFaasHubs({ n: 3 }) (agent test-helpers copy)
  it('connects over HTTP when the site offers only http and runs a session end to end', …);
  it('cut after delivery before processing: command executed once', …); // Review Focus #3
  it('streams rotate every 300 ms for 5 s: events in the browser SSE are contiguous with no duplicates', …);
  it('random cuts every 150 ms during a run with 10 site tool calls: each handler runs once, the run completes', …); // Review Focus #2
  it('an upstream body never exceeds 1 MB (large events and file chunks are split)', …);
  it('falls back to HTTP when WebSocket upgrades fail 3 times in a row', …);
  it('426 on connect triggers the self-upgrade path (onUpgradeRequired)', …);
  // doctor.test.ts
  it('doctor prints each site’s transports and warns when minAgentVersion is above the installed agent', …);
  ```
- [ ] Step: run → FAIL: `pnpm --filter @uncage/agent exec vitest run src/transport.test.ts src/faas.test.ts && pnpm --filter @uncage/cli exec vitest run src/doctor.test.ts`
- [ ] Step: implement: move the socket code of `connectOnce` into `dialWs`; `SiteAgent.loop` calls `fetchAgentInfo` before each dial (cache 5 min), `chooseTransport`, then `dialWs`/`dialHttp`, and keeps replication/commands/tools/pulls/uploads transport-neutral via `AgentLink.send`; `SiteAgentOptions.fetch?: typeof fetch` (tests); `uncage setup` prints the transport from `transports`; `uncage doctor` calls `/agent/info`.
- [ ] Step: run → PASS: `pnpm --filter @uncage/agent test && pnpm --filter @uncage/cli test` (all green)
- [ ] Step: commit `feat(agent): HTTP streaming transport with cursor resume, idempotent upstream and automatic transport choice`

---

### Task 9: Browser SSE rotation and seamless resume

**Files:**
- Modify: `packages/server/src/wire.ts`, `packages/hub/src/sse.ts`, `packages/hub/src/browser-api.ts`, `packages/client/src/client.ts`, `packages/react/src/store.ts` (only if the test shows a gap)
- Test: `packages/hub/src/hub.test.ts`, `packages/client/src/client.test.ts`, `packages/react/src/store.test.ts`

**Interfaces — Produces:**
```ts
// @uncage/server/wire
export const STREAM_RECONNECT_EVENT = 'reconnect';
export const formatReconnectFrame = (): string => 'event: reconnect\ndata: {}\n\n';
// hub sse.ts
export function eventStreamResponse(src: EventSource, o: { after: number; heartbeatMs: number; maxDurationMs: number; signals: AbortSignal[]; requestId: string }): Response;
```
- [ ] Step: failing tests.
  ```ts
  it('browser SSE ends with event: reconnect at stream.maxDurationMs', async () => { /* maxDurationMs 300 → frame 'reconnect' then body done */ });
  it('client: a reconnect frame resumes at once with Last-Event-ID, no state change, no gap or duplicate', async () => {
    // server: 3 rotations of 100 ms while events 1..50 are produced
    expect(states).toEqual(['connecting', 'live']); expect(seen).toEqual(range(1, 50));
    expect(requests[1].headers.get('last-event-id')).toBe(lastIdOfFirstStream);
  });
  it('client: a stream cut without the reconnect frame (platform timeout) still recovers with backoff', …);
  it('react store: rotation keeps the timeline intact', …);
  ```
- [ ] Step: run → FAIL: `pnpm --filter @uncage/client test && pnpm --filter @uncage/hub exec vitest run src/hub.test.ts && pnpm --filter @uncage/react test`
- [ ] Step: implement: `pump` writes `formatReconnectFrame()` and ends at `maxDurationMs` (hub passes `stream.maxDurationMs`); `client.subscribe` treats `frame.event === STREAM_RECONNECT_EVENT` as "end of this response, reconnect now" (no backoff, `attempt = 0`, state unchanged).
- [ ] Step: run → PASS (same commands, all green)
- [ ] Step: commit `feat(client): seamless SSE rotation with Last-Event-ID resume for platforms that cut long responses`

---

### Task 10: `toNextHandlers`, `fetchOnce` and the website-side "agent outdated" notice

**Files:**
- Create: `packages/hub/src/fetch-adapters.ts`
- Modify: `packages/hub/src/index.ts`, `packages/react-ui/src/{components/MachineStatus.tsx,components/AgentChat.tsx,i18n.ts,index.ts}`
- Create: `packages/react-ui/src/components/AgentOutdatedNotice.tsx`
- Test: create `packages/hub/src/fetch-adapters.test.ts`; modify `packages/react-ui/src/connected.test.tsx`

**Interfaces — Produces:**
```ts
type RouteHandler = (req: Request) => Promise<Response>;
/** Next.js App Router: export const { GET, POST, PATCH, DELETE } = toNextHandlers(getHub). `hub` may be a lazy getter (memoized) so `next build` never connects. */
export function toNextHandlers(hub: Hub | Promise<Hub> | (() => Hub | Promise<Hub>), o?: { clientIp?(req: Request): string | undefined; waitUntil?(p: Promise<unknown>): void }): { GET: RouteHandler; POST: RouteHandler; PATCH: RouteHandler; DELETE: RouteHandler };
/** Platforms that forbid sharing I/O objects across requests (Cloudflare Workers): one hub per request, closed after the response body ends. */
export function fetchOnce(create: () => Promise<Hub>, req: Request, o?: { clientIp?: string; waitUntil?(p: Promise<unknown>): void }): Promise<Response>;
// react-ui
export function AgentOutdatedNotice(props: { machine: MachineInfo }): JSX.Element | null;
// i18n (en + zh; ja falls back to en as today)
agentOutdated: (setup: string) => string; // en: `This computer's Uncage agent is too old for this website. On that computer run \`npm i -g @uncage/cli@latest\`, then \`${setup}\`.`
                                          // zh: `这台电脑上的 Uncage 守护进程版本过旧。请在那台电脑上运行 \`npm i -g @uncage/cli@latest\`，然后运行 \`${setup}\` 重新连接。`
machineAgentOutdated: string;             // en 'Agent update needed' · zh '需要更新守护进程'
```
- [ ] Step: failing tests.
  ```ts
  it('toNextHandlers calls a lazy getter once and routes every method to hub.fetch', …);
  it('fetchOnce closes the hub only after a streamed body finished or was cancelled', …);
  it('AgentOutdatedNotice shows the upgrade command with the site setup command for an outdated computer', async () => {
    render(<AgentChat />, { machines: [{ ...m, agentOutdated: true }] });
    expect(screen.getByRole('status')).toHaveTextContent('npm i -g @uncage/cli@latest');
  });
  it('MachineStatus lists an outdated computer as "Agent update needed"', …);
  ```
- [ ] Step: run → FAIL: `pnpm --filter @uncage/hub exec vitest run src/fetch-adapters.test.ts && pnpm --filter @uncage/react-ui test`
- [ ] Step: implement (the notice reads `setup` from `client.installInfo()`; rendered above the composer when the current machine is outdated).
- [ ] Step: run → PASS (same commands, all green)
- [ ] Step: commit `feat(hub,react-ui): Next.js and per-request fetch adapters; tell users when their computer's agent is too old`

---

### Task 11: connected-demo runs in both modes (Railway and Vercel)

**Files:**
- Create: `examples/connected-demo/app/api/uncage/[[...path]]/route.ts`, `examples/connected-demo/vercel.json`, `examples/connected-demo/lib/mode.ts`
- Modify: `examples/connected-demo/{server.ts,lib/hub.ts,lib/hub-registry.ts,lib/assets.ts,lib/auth.ts,lib/tools.ts,app/device/actions.ts,app/device/page.tsx,app/asset-files/[id]/[...path]/route.ts,app/assets/**,package.json,next.config.ts,README.md,DEPLOY.md}`
- Create: `e2e/connected/faas.spec.ts`; modify `e2e/connected/stack.ts` (`demoFaas(port, env)` spawns `next start` in the demo dir; `count(proc, re)` counts matches in `proc.output()`), `e2e/playwright.config.ts` (`CONNECTED_PORTS.faas = 3240`, project `connected-faas-mock` in `e2e:mock`), `e2e/package.json`
- Test: `examples/connected-demo/lib/demo.test.ts`, the e2e spec

**Interfaces — Produces:**
```ts
// lib/mode.ts — the entry decides: `node server.ts` publishes its hub (traditional); otherwise (next start / Vercel) the route handler builds one (FaaS)
export function demoMode(): 'traditional' | 'faas';
export function requireFaasEnv(env?: Record<string, string | undefined>): void; // throws listing missing DATABASE_URL / DEMO_SECRET
// lib/hub-registry.ts
export function getHub(): Promise<Hub>; // published hub, else memoized createDemoHub({ mode: 'faas' })
// lib/hub.ts
export function createDemoHub(o: { mode: 'traditional' | 'faas'; env?: NodeJS.ProcessEnv }): Promise<{ hub: Hub; close(): Promise<void> }>;
// faas: postgresHubStore + (REDIS_URL ? redisCluster : postgresCluster); stream.maxDurationMs = Number(env.UNCAGE_STREAM_MAX_MS) || 250_000;
//       maintenance: { secret: env.CRON_SECRET, onRun: public demo → assetStore().purgeOlderThan(24 * 3600_000) }
// lib/assets.ts
export interface AssetStore {
  create(o: { owner: string; title: string; kind: AssetKind; sessionId: string }): Promise<Asset>;
  get(id: string): Promise<Asset | null>; list(owner: string): Promise<Asset[]>; count(owner: string): Promise<number>;
  publish(id: string, files: Array<{ path: string; data: Uint8Array }>): Promise<Asset>;
  readFile(id: string, path: string): Promise<{ data: Uint8Array; contentType: string } | null>;
  purgeOlderThan(maxAgeMs: number, now?: number): Promise<number>;
}
export function fileAssetStore(dir: string): AssetStore;
export function postgresAssetStore(pool: PgPoolLike): AssetStore; // tables demo_assets, demo_asset_files (bytea), created on first use
export function assetStore(): AssetStore;                         // DATABASE_URL → postgres, else files under the data dir
// route.ts
export const { GET, POST, PATCH, DELETE } = toNextHandlers(getHub, { clientIp });
export const maxDuration = 300; export const dynamic = 'force-dynamic'; export const runtime = 'nodejs';
```
`vercel.json`: `{ "crons": [{ "path": "/api/uncage/maintenance", "schedule": "0 4 * * *" }] }`. Scripts: `"start:faas": "next start"`, `"dev:faas": "next dev"`. Quotas unchanged: `PUBLIC_MAX_ASSETS_PER_OWNER = 20`, `PUBLISH_MAX_BYTES = 20 * 1024 * 1024`. In FaaS mode `secret()` never touches the disk: `DEMO_SECRET` (≥ 32 bytes) is required.

- [ ] Step: failing tests.
  ```ts
  it('fileAssetStore and postgresAssetStore (PGlite pool shim) pass the same asset contract incl. 20 assets per owner and 20 MB per publish', …);
  it('FaaS mode without DEMO_SECRET or DATABASE_URL fails with a message naming the missing variables', …);
  it('demoMode is traditional when server.ts published a hub and faas otherwise', …);
  // e2e/connected/faas.spec.ts (docker Postgres; `next start`, no custom server; UNCAGE_STREAM_MAX_MS=5000; DEMO_PUBLIC=1; fake-adapter agent with tmp UNCAGE_HOME)
  test('FaaS demo: connect over HTTP streaming, run, approve, publish, reload history, offline', async ({ page }) => {
    const demo = await stack.demoFaas(CONNECTED_PORTS.faas, { DATABASE_URL, DEMO_SECRET, UNCAGE_STREAM_MAX_MS: '5000', DEMO_PUBLIC: '1' });
    let agentProc!: Proc;
    await connectedGoldenPath({ page, stack, url: demo.url, agent: async (home) => (agentProc = await stack.fakeAgent(home)), runTimeoutMs: 120_000 });
    expect(stack.count(agentProc, /http stream rotated/)).toBeGreaterThanOrEqual(2); // rotations happened
  });
  ```
- [ ] Step: run → FAIL: `pnpm --filter connected-demo test && pnpm --filter connected-demo build && pnpm --filter @uncage/e2e exec playwright test --project=connected-faas-mock`
- [ ] Step: implement as specified; `server.ts` keeps traditional mode (`toNodeHandler` + `attachWebSocket` from `@uncage/hub/node`, hourly purge timer); DEPLOY.md gets a Vercel section (env: `DATABASE_URL`, `DEMO_SECRET`, `CRON_SECRET`, `PUBLIC_URL`, `DEMO_PUBLIC`).
- [ ] Step: run → PASS (same commands, plus `pnpm e2e:mock` all green)
- [ ] Step: commit `feat(demo): one codebase, two entries — server.ts (traditional) and a Next route handler (FaaS) with Postgres-backed assets`

---

### Task 12: `examples/connected-cloudflare` (native Worker, `wrangler dev`)

**Files:**
- Create: `examples/connected-cloudflare/{package.json,wrangler.toml,tsconfig.json,README.md,src/worker.ts,src/hub.ts,src/auth.ts,src/tools.ts,src/skills.ts,scripts/smoke.ts}`
- Modify: `pnpm-workspace.yaml` (if examples are not globbed), `.changeset/config.json` (`ignore` += `connected-cloudflare`)
- Test: `examples/connected-cloudflare/src/worker.test.ts` (Vitest, `fetchOnce` with PGlite store, no workerd) and the dry-run bundle check

**Interfaces — Produces:**
```ts
// src/hub.ts
export interface Env { HYPERDRIVE: { connectionString: string }; DEMO_SECRET: string; PUBLIC_URL: string; CRON_SECRET?: string }
export function makeHub(env: Env): Promise<Hub>; // new pg.Pool per request (Workers forbid cross-request I/O); postgresHubStore({ pool }) + postgresCluster({ pool }); tools [saveNote]; skills [notesSkill]
// src/worker.ts
export default { fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> };
// routes: /api/uncage/* → fetchOnce(() => makeHub(env), req, { waitUntil: ctx.waitUntil.bind(ctx), clientIp: req.headers.get('cf-connecting-ip') ?? undefined });
//         GET /login?user=<name> (demo cookie, HMAC with crypto.subtle) · GET|POST /device (plain HTML approve form → hub.approveDevice) · GET /notes (JSON)
// src/tools.ts
export const saveNote: SiteTool<{ title: string; body: string }>; // inserts into cf_demo_notes for ctx.user.id
```
`wrangler.toml`: `compatibility_date = "2026-10-01"`, `compatibility_flags = ["nodejs_compat"]` (for `pg` only; the hub itself needs none), `[[hyperdrive]] binding = "HYPERDRIVE"` with `localConnectionString = "postgres://uncage:uncage@127.0.0.1:5432/uncage"`. `scripts/smoke.ts`: logs in, creates a session, starts a run asking Claude Code to call `save_note`, reads SSE to `run.completed`, checks `/notes`.

- [ ] Step: failing tests.
  ```ts
  it('worker routes the hub through fetchOnce and closes the hub after the response', …);
  it('saveNote stores a note for the session owner only', …);
  it('wrangler bundles the worker without errors', () => { // Review Focus #5
    const r = spawnSync('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', tmp], { cwd: exampleDir, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });
  ```
- [ ] Step: run → FAIL: `pnpm --filter connected-cloudflare test`
- [ ] Step: implement as specified (native Worker, no Hono).
- [ ] Step: run → PASS: `pnpm --filter connected-cloudflare test` and a manual `pnpm --filter connected-cloudflare exec wrangler dev` answers `GET /api/uncage/agent/info` with `transports: [{ kind: 'http', … }]`
- [ ] Step: commit `feat(examples): Cloudflare Workers example on wrangler dev with Hyperdrive Postgres`

---

### Task 13: Multi-instance scenario on real Postgres (Docker)

**Files:**
- Create: `packages/hub/src/faas-scenario.ts`
- Modify: `packages/hub/src/multinode.test.ts`, `packages/hub/src/real-services.docker.test.ts`
- Test: those files

**Interfaces — Produces:**
```ts
/** Three hub instances (own pools), every request routed to a chosen instance: machine stream on X, browser on Y, tool POSTs on Z. */
export function runFaasScenario(o: { makeStore(): Promise<HubStore>; makeCluster(): ClusterAdapter; streamMaxMs: number }): Promise<void>;
```
Scenario assertions: session create/list on Y; events visible over browser SSE on Y with `maxDurationMs` rotations (contiguous, no duplicates); one approval decided on Z reaches the machine once; a tool call POSTed to Z pulls a 3-file directory (one file 2 MB) while the stream is on X; an 8 MB attachment upload from Y reaches the machine; machine shows offline on Y within presence TTL after the agent disconnects; `maintain()` from any instance prunes acked outbox rows.

- [ ] Step: failing tests: `it('FaaS scenario: sqlCluster + one PGlite store (in-process)', …)` in `multinode.test.ts`; `it('FaaS scenario: postgresCluster + postgresHubStore on Postgres 16, 3 instances', …)` in the docker file.
- [ ] Step: run → FAIL: `pnpm --filter @uncage/hub exec vitest run src/multinode.test.ts` and `UNCAGE_DOCKER_TESTS=1 pnpm --filter @uncage/hub exec vitest run --project docker`
- [ ] Step: implement `runFaasScenario` on `startFaasHubs` + `connectFakeHttpAgent`; fix what it exposes.
- [ ] Step: run → PASS (both, all green; record the measured poll query rate idle vs active in the commit body)
- [ ] Step: commit `test(hub): three-instance FaaS scenario on real Postgres`

---

### Task 14: Help site (English)

**Files:**
- Create: `apps/docs/src/content/docs/start/choose-deployment-mode.md`, `apps/docs/src/content/docs/deploy/{node.md,vercel.md,cloudflare-workers.md,other-fetch-platforms.md}`, `apps/docs/src/content/docs/reference/migrate-from-0-2.md`
- Modify: `apps/docs/src/nav.mjs` (Start here += `start/choose-deployment-mode`; new section `{ label: 'Deploy', zh: '部署', ja: 'デプロイ', items: ['deploy/node', 'deploy/vercel', 'deploy/cloudflare-workers', 'deploy/other-fetch-platforms'] }`; Reference += `reference/migrate-from-0-2`), `apps/docs/i18n-glossary.md` (rows: deployment mode 部署模式 / デプロイモード; traditional mode 传统模式 / 従来モード（常駐プロセス）; FaaS mode FaaS 模式 / FaaS モード; transport 传输方式 / トランスポート; HTTP streaming HTTP 流式传输 / HTTP ストリーミング; function instance 函数实例 / 関数インスタンス; maintenance 维护任务 / メンテナンス)
- Modify: `apps/docs/src/content/docs/{start/how-it-works.md,start/quickstart-connected.md,start/for-coding-agents.md,start/try-the-demo.mdx,guides/mount-the-hub.md,guides/multi-node.md,guides/define-tools.md,guides/auth-and-device-approval.md,guides/site-storage.md,reference/http-api.md,reference/troubleshooting.md,reference/glossary.md,reference/cli.md,reference/errors.md}`, `skills/uncage/SKILL.md`, `packages/hub/README.md`, `README.md`, `examples/connected-demo/README.md`

Content requirements: choose-deployment-mode has the comparison table (traditional vs FaaS: dependencies, latency ~instant vs ~300 ms active / ≤ 2 s idle, cost — each online computer holds about one continuous function invocation —, platforms) and a decision flow ("Where does your website run?" → page) as a mermaid diagram, plus when to switch to traditional mode or add Redis. Each deploy page: prerequisites, complete copyable code (snippet-checked, `title="…"` files), env vars, deploy steps, verification checklist, FAQ (504/timeouts, `maxDuration` vs `stream.maxDurationMs`, `toolTimeoutMs` within the platform limit, request body ~4.5 MB on Vercel, Neon: use its `Pool`, not the HTTP-only `neon()` function, Workers: one hub per request via `fetchOnce`). how-it-works gets the transport-negotiation diagram; http-api documents the agent transport (routes, NDJSON lines, cursor/ack, idempotent ids, 1 MB limit); troubleshooting adds 504/timeouts, cut connections, old agent (426 / "agent update needed"); migrate-from-0-2 lists every breaking change (store required, `hub.handler` → `hub.fetch`, `hub.attach` → `attachWebSocket`, `@uncage/hub/node`, agent ≥ 0.3, `@uncage/server/wire` no longer re-exports `toNodeHandler`, `HubStore` additions, rate limits now in the store).

- [ ] Step: failing check: `pnpm --filter docs check:snippets` (fails on 0.2 snippets) and add to `apps/docs/scripts/markdown.test.ts`: `it('every deploy page has the six required sections', …)` asserting headings `Prerequisites`, `Code`, `Environment variables`, `Deploy`, `Verify`, `FAQ`.
- [ ] Step: run → FAIL: `pnpm --filter docs exec vitest run && pnpm --filter docs check:snippets`
- [ ] Step: write the pages; all snippets compile against the built packages.
- [ ] Step: run → PASS: `pnpm build && pnpm --filter docs exec vitest run && pnpm --filter docs check:snippets && pnpm --filter docs build` (links validator green; `check-i18n --allow-missing` warnings only)
- [ ] Step: commit `docs: deployment modes, platform guides (Node, Vercel, Cloudflare Workers, other Fetch platforms) and 0.2 migration`

---

### Task 15: Help site translations (zh-CN, ja)

**Files:**
- Create/Modify: the zh-cn and ja counterparts of every page created or changed in Task 14 under `apps/docs/src/content/docs/zh-cn/**` and `apps/docs/src/content/docs/ja/**`

- [ ] Step: failing check: `pnpm --filter docs check:i18n` (missing pages, code-block mismatches)
- [ ] Step: run → FAIL: `pnpm --filter docs check:i18n`
- [ ] Step: translate following `i18n-glossary.md` (code blocks byte-identical to English, locale-prefixed links, ja uses ハブ / コンピュータ / 従来モード).
- [ ] Step: run → PASS: `pnpm --filter docs check` (snippets + strict i18n + build with link validation, all green)
- [ ] Step: commit `docs(i18n): zh-CN and ja for deployment modes, platform guides and migration`

---

### Task 16: Website — serverless transport is available (3 languages)

**Files:**
- Modify: `apps/site/src/i18n/{schema.ts,en.ts,zh.ts,ja.ts}`, `apps/site/src/components/Features.astro`, `apps/site/tests/i18n.test.ts`, `apps/site/e2e.spec.ts` (if it counts cards)

Decision: keep the 3×2 "available" grid by turning "Scales out" into "Runs anywhere" (icon `cloud`): en "Runs anywhere — A long-running Node server, Vercel, Cloudflare Workers or any Fetch platform. FaaS mode needs only Postgres; add Redis to scale out." (zh/ja translated with the glossary); `soon` becomes `Three<Feature>` (Codex verified, Windows and Linux agents, More entry points; icons `terminal`, `monitor`, `phone`). `code.sub` drops "your Node server" for "your server or functions platform".

- [ ] Step: failing test in `tests/i18n.test.ts`: `it('no locale still lists serverless transport as coming soon', () => { for (const d of [en, zh, ja]) expect(JSON.stringify(d.features.soon)).not.toMatch(/Serverless|无服务器|サーバーレス|Vercel/); })` and `expect(d.features.soon).toHaveLength(3)`.
- [ ] Step: run → FAIL: `pnpm --filter site test`
- [ ] Step: implement the dictionary, schema and icon changes.
- [ ] Step: run → PASS: `pnpm --filter site check && pnpm --filter site exec playwright test` (system Chrome, all green)
- [ ] Step: commit `feat(site): serverless-ready transport is available — runs anywhere (en, zh, ja)`

---

### Task 17: End-to-end verification with real Claude Code

**Files:**
- Create: `e2e/connected/faas-live.spec.ts` (project `connected-faas-live`), `e2e/connected/cloudflare-live.spec.ts` (project `connected-cloudflare-live`)
- Modify: `e2e/playwright.config.ts`, `e2e/package.json` (`e2e:live` includes both), `e2e/connected/stack.ts` (`wrangler(port, env)`, `demoContainer(port)`)

- [ ] Step: failing specs (they fail until the stack helpers exist):
  ```ts
  // faas-live.spec.ts — Vercel shape: `next build && next start` (no custom server), docker Postgres, UNCAGE_STREAM_MAX_MS=30000, real `uncage setup` + real `uncage agent` (tmp UNCAGE_HOME), Claude Code selected
  test('FaaS mode with real Claude Code: connect → streaming → approval → site tool → publish → reload history → offline', async ({ page }) => {
    let agentProc!: Proc;
    await connectedGoldenPath({ page, stack, url: demo.url, agent: async (home) => (agentProc = await stack.realAgent(home)), runTimeoutMs: 600_000 });
    expect(stack.count(agentProc, /http stream rotated/)).toBeGreaterThanOrEqual(2);
  });
  // cloudflare-live.spec.ts — `wrangler dev` (workerd) + docker Postgres via Hyperdrive localConnectionString, real agent
  test('Cloudflare Workers with real Claude Code: connect → one run calling save_note', …);
  ```
- [ ] Step: run → FAIL: `UNCAGE_LIVE=1 pnpm --filter @uncage/e2e exec playwright test --project=connected-faas-live --project=connected-cloudflare-live`
- [ ] Step: implement the stack helpers; run the traditional regression: `docker build -t uncage-demo examples/connected-demo/..` per `Dockerfile` + golden path against the container (`stack.demoContainer`), `pnpm e2e:mock`, `UNCAGE_LIVE=1 pnpm e2e:live --project=connected-live`.
- [ ] Step: run → PASS: `pnpm build && pnpm test && pnpm typecheck && pnpm lint && UNCAGE_DOCKER_TESTS=1 pnpm --filter @uncage/hub test && pnpm e2e:mock && UNCAGE_LIVE=1 pnpm e2e:live` (all green; screenshots and logs in `e2e/connected/results/`)
- [ ] Step: commit `test(e2e): real Claude Code on the Vercel shape (next start) and on wrangler dev; traditional container regression`; push `feat/faas-mode` and write the PR title + description (spec acceptance items with evidence, ending with the 🤖 attribution line) for the user to open.

---

### Task 18: Release prep 0.3.0

**Files:**
- Create: `.changeset/uncage-0-3-platform-agnostic.md`
- Modified by `pnpm changeset version` on `release/0.3.0`: every public `packages/*/package.json` (0.3.0) and `packages/*/CHANGELOG.md`

- [ ] Step: failing check: `node -e "for (const p of ['protocol','core','server','client','react','react-ui','runtime-claude','runtime-codex','cli','hub','agent']) { const v = require('./packages/' + p + '/package.json').version; if (v !== '0.3.0') { console.error(p, v); process.exitCode = 1 } }"`
- [ ] Step: run → FAIL (versions are 0.2.0)
- [ ] Step: add the changeset (`"@uncage/hub": minor` … every public package, `minor`; body: FaaS mode + traditional mode, breaking changes with a link to `/docs/reference/migrate-from-0-2/`); commit it on `feat/faas-mode`, then `git switch -c release/0.3.0 feat/faas-mode && pnpm changeset version` (the release branch carries the feature work plus the version bump, so the user can open one PR); confirm `MIN_AGENT_VERSION === '0.3.0'` and `install.sh` installs `@uncage/cli@^0.3`.
- [ ] Step: run → PASS: the version check above, then `pnpm build && pnpm test && pnpm typecheck && pnpm lint`
- [ ] Step: commit `chore: version packages (0.3.0)`; push `release/0.3.0`; hand the user the PR title (`chore: release 0.3.0`), description (ending with the 🤖 attribution line) and compare URL — the user only opens and merges it.
