# Uncage 0.2 Connected Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A website built with Uncage lets its users connect their own machine with `curl … | bash` + `uncage setup <url>`, then command their local Claude Code from inside the website; CC calls the website's declared tools (as the user) and the process plus resulting assets live on the website. Multi-node hub deployment, a reference demo site, and a developer + coding-agent friendly help site.

**Architecture:** New `@uncage/hub` (mounted in the website's Node backend or run standalone) owns device login, machine WebSocket connections, a browser API with the same shape as today's daemon API (so `@uncage/client`/`react`/`react-ui` are reused), site tools/skills, website-side session storage and a pluggable cluster adapter (memory / Redis). New `@uncage/agent` (daemon on the user's machine, started by `uncage setup`, kept alive by launchd) dials out to one or more hubs over WSS and drives the existing `@uncage/core` + runtime adapters, injecting site tools as an in-process MCP server and skills as `.claude/skills`. Local Mode (V0) stays.

**Tech Stack:** existing monorepo (TS ^6.0.3 pinned, Zod 4, Fastify 5, PGlite + Drizzle, React 19, Next 16, Vitest, Playwright with system Chrome), `ws` (WebSocket), `ioredis` (+ `ioredis-mock` for tests), `pg` (Postgres store), `@anthropic-ai/claude-agent-sdk` 0.3.318 (`createSdkMcpServer`, `tool`, `allowedTools`), launchd, Astro Starlight (help site).

**Spec:** `docs/superpowers/specs/2026-11-07-uncage-connected-design.md` (incl. §7.1 trust model and §10 rulings).

## Global Constraints

- All existing global constraints (V0 + composer) hold; Local Mode must not regress (`pnpm test`, `pnpm e2e:mock`, `pnpm e2e:live` keep passing).
- Trust model (spec §7.1): website trusted by default; `bypassPermissions` can only be enabled on the user's machine (`~/.uncage/agent.yaml` `localPolicy.allowBypass: true`), never by the hub; optional local cap `localPolicy.allowedPermissionModes`; full local activity log.
- The hub never sends executable code or shell to machines; only declarative data (tool manifests, skill text/templates, commands from the fixed command set).
- Machine token: one per (machine, site), random 32 bytes base64url, stored only in `~/.uncage/agent.yaml` (mode 0600), revocable from website and CLI, never logged or put in events.
- Wire: WSS (WS allowed only for `localhost`/`127.0.0.1` hubs in dev); protocol version `1`; hub declares `minAgentVersion`; agent supports current + previous minor.
- Multi-node: hub must work with ≥2 instances behind a load balancer (machine on node A, browser on node B) via `ClusterAdapter` (memory default, Redis provided) and a shared `HubStore` (PGlite single-node default, Postgres provided).
- Session data truth is the machine's local PGlite; website-side storage is an async replica keyed by `(sessionId, sequence)`.
- Per-session workspace on the machine: `~/Uncage/<siteHost>/<sessionId>/` (realpath-fenced); local data dir per site: `~/.uncage/sites/<siteId>/`.
- Problems hit during execution are logged in the ledger and the recommended option is taken without blocking (user instruction).

## Review Focus

1. **Machine goes offline mid-run** (laptop sleep, Wi-Fi drop): the browser shows “machine offline” within 30 s, the run keeps going locally, and on reconnect missed events backfill without duplicates. Test: Task 5 + Task 6.
2. **A browser user tries to reach another user's machine or session** (guessing ids): 404, never cross-user data. Test: Task 5.
3. **Two hub nodes**: approve on node B for a run whose machine is connected to node A → exactly one decision reaches the machine. Test: Task 7.
4. **Hub sends a tool manifest whose tool name collides with a built-in or contains odd characters** → sanitized/rejected, never shadows CC built-ins. Test: Task 4.
5. **`file_pull` of a path outside the session workspace or a huge directory** → rejected / capped with a clear error. Test: Task 6.

---

## File Structure

```text
packages/protocol/src/connected.ts           # wire frames, machine/device/tool/skill types
packages/core/src/…                           # tool/skill run inputs, global event listener, public Store
packages/runtime-claude/src/site-tools.ts     # MCP injection + skills materialization
packages/hub/src/{hub.ts, device.ts, machines.ts, browser-api.ts, tools.ts, files.ts, cluster/{memory,redis}.ts, store/{store,pglite,postgres}.ts, node.ts, install-script.ts, index.ts}
packages/agent/src/{agent.ts, connection.ts, commands.ts, replication.ts, tools-bridge.ts, files.ts, policy.ts, activity.ts, config.ts, index.ts}
packages/cli/src/{setup.ts, agent-cmd.ts, launchd.ts, sites.ts, activity-cmd.ts}
packages/server/src/node-handler.ts           # createUncageNodeHandler (F4)
packages/client|react|react-ui                # machines API, ConnectMachine, ApproveDevice, machine picker, F1/F2/F6
examples/connected-demo/                      # reference website (Next + custom Node server + hub)
e2e/connected/                                 # mock + live specs, multi-node
apps/docs/                                     # help site (Starlight) + llms.txt + SKILL.md
```

---

### Task 1: Local-mode fixes from the demo verification (F1–F6)

**Files:** `packages/react-ui/src/components/AgentChat.tsx`, `packages/react/src/store.ts`, `packages/core/src/sessions.ts`, `packages/server/src/proxy.ts`, create `packages/server/src/node-handler.ts`, `packages/cli/src/{bin.ts,doctor.ts}`, `packages/client/src/{index.ts,client.ts}`, `packages/client/README.md`, README.md.

**Interfaces — Produces:**
```ts
// @uncage/server/proxy
export function createUncageNodeHandler(o?: ProxyOptions): (req: import('http').IncomingMessage, res: import('http').ServerResponse, next?: (err?: unknown) => void) => void;
// @uncage/react-ui
interface AgentChatProps { persistSession?: 'url' | 'localStorage' | false /* default 'url' (?session=<id>) */ }
```
- F1: `<AgentChat>` restores the last active session on reload by default (`?session=` param, replaceState); test reload restores.
- F2: session `title` = first prompt (trimmed, ≤60 chars) set on first run (core emits `session.updated`); store sorts sessions newest-first consistently before and after reload.
- F3: proxy 403 for Origin/Host mismatch says which header mismatched and the fix (`changeOrigin: false` / `allowedHosts`), never the daemon's `allowedOrigins`.
- F4: `createUncageNodeHandler` (Express/Fastify-compatible, streams SSE, `duplex:'half'` bodies); README Express snippet (≤5 lines).
- F5: `uncage doctor` accepts `--port`, `--help`, honors `UNCAGE_URL`; git-ignore check runs on the configured workspace, not cwd.
- F6: `@uncage/client` re-exports protocol types; replace runtime zod validation in the browser path with a lightweight structural guard (bundle ≤ 25 KB min); document the API and `Idempotency-Key` in its README.
- [ ] Tests first for each (react-ui reload, core title, proxy message, node handler SSE streaming with a real http server, doctor flags, client bundle size check via esbuild metafile in a test), implement, `pnpm test && pnpm e2e:mock`, commit `fix: local-mode polish (session restore, titles, node handler, doctor, client)`.

---

### Task 2: Protocol — connected-mode wire types

**Files:** create `packages/protocol/src/connected.ts`; export from index; tests `connected.test.ts`.

**Interfaces — Produces:**
```ts
export const CONNECTED_PROTOCOL = 1;
export interface MachineInfo { id: string; name: string; os: string; agentVersion: string; runtimes: RuntimeInfo[]; online: boolean; lastSeenAt: string }
export interface ToolSpec { name: string /* ^[a-z][a-z0-9_]{0,47}$ */; description: string; inputSchema: Record<string, unknown> /* JSON Schema */; requiresConfirmation: boolean }
export interface SkillSpec { name: string /* ^[a-z][a-z0-9-]{0,47}$ */; description: string; markdown: string; files?: Array<{ path: string; content: string }> }
export interface SessionManifest { tools: ToolSpec[]; skills: SkillSpec[] }
export type HubCommandOp = 'createSession'|'startRun'|'cancelRun'|'decide'|'updateSettings'|'addAttachment'|'snapshot'|'listSessions'|'readEvents';
export type AgentFrame =
  | { t: 'hello'; protocol: number; agentVersion: string; machine: { name: string; os: string; runtimes: RuntimeInfo[] } }
  | { t: 'result'; id: string; ok: true; data: unknown } | { t: 'result'; id: string; ok: false; error: ErrorBody }
  | { t: 'events'; sessionId: string; events: UncageEvent[] }
  | { t: 'tool_call'; id: string; sessionId: string; runId: string; tool: string; args: unknown }
  | { t: 'file_chunk'; id: string; path: string; seq: number; data: string /* base64 */; last: boolean }
  | { t: 'file_done'; id: string; files: Array<{ path: string; size: number }> } | { t: 'pong'; at: number };
export type HubFrame =
  | { t: 'welcome'; machineId: string; protocol: number; minAgentVersion: string }
  | { t: 'upgrade_required'; minAgentVersion: string }
  | { t: 'command'; id: string; op: HubCommandOp; args: unknown }
  | { t: 'ack'; sessionId: string; sequence: number }
  | { t: 'tool_result'; id: string; ok: true; result: ToolCallResult } | { t: 'tool_result'; id: string; ok: false; error: ErrorBody }
  | { t: 'file_pull'; id: string; sessionId: string; path: string; maxBytes: number } | { t: 'ping'; at: number };
export interface ToolCallResult { content: Array<{ type: 'text'; text: string } | { type: 'json'; json: unknown }>; isError?: boolean }
export interface DeviceCodeResponse { deviceCode: string; userCode: string /* 'ABCD-EFGH' */; verificationUri: string; intervalSec: number; expiresInSec: number /* 600 */ }
export type DeviceTokenResponse = { status: 'pending' } | { status: 'denied' } | { status: 'expired' } | { status: 'ok'; machineId: string; machineToken: string; site: { id: string; name: string; url: string } };
// ErrorCode gains: 'machine_offline' (409), 'machine_not_found' (404), 'upgrade_required' (426), 'tool_failed' (502), 'device_code_expired' (410)
export function parseAgentFrame(raw: string): AgentFrame;   // throws invalid_request
export function parseHubFrame(raw: string): HubFrame;
```
- [ ] Tests: each frame round-trips; invalid tool/skill names rejected (`Bash`, `mcp__x`, `a b`); unknown `t` rejected; 1 MB frame limit constant `MAX_FRAME_BYTES = 1_048_576`. Implement, commit `feat(protocol): connected-mode wire types`.

---

### Task 3: Core — run tools/skills inputs, replication hooks, public Store

**Files:** `packages/protocol/src/runtime.ts` (AdapterRunInput), `packages/core/src/{runs.ts, uncage.ts, event-log.ts, index.ts}`.

**Interfaces — Produces:**
```ts
// AdapterRunInput gains:
tools?: Array<ToolSpec & { call(args: unknown): Promise<ToolCallResult> }>;
skills?: SkillSpec[];
// RuntimeCapabilities gains: siteTools: boolean
// UncageOptions gains: onEvent?(e: UncageEvent): void   (called after commit, every session)
// SessionHandle.startRun({ …, manifest?: SessionManifest, callTool?: (tool: string, args: unknown, ctx: { sessionId: string; runId: string }) => Promise<ToolCallResult> })
// Uncage gains: events.readAfter(sessionId: string, after: number, limit?: number): Promise<UncageEvent[]>
// @uncage/core exports Store, openPgliteStore (already) + docs
```
- Core passes `manifest.tools` (wrapped with `call` → `callTool`) and `manifest.skills` to the adapter; rejects a manifest with tools when `capabilities.siteTools` is false (`unsupported_capability`).
- [ ] Tests: onEvent fires once per committed event in order; readAfter paging; manifest passed to fake adapter; siteTools false → rejected. Commit `feat(core): site tools/skills in runs and event listener`.

---

### Task 4: Claude adapter — site tools via in-process MCP, skills as files

**Files:** create `packages/runtime-claude/src/site-tools.ts`; modify `adapter.ts`, `capabilities.ts`; testkit fake adapter gains tool calling step.

- `siteTools: true` for Claude; Codex `false` (Task note in compatibility).
- `createSdkMcpServer({ name: 'site', tools })`; each ToolSpec → SDK `tool(name, description, zodShape, handler)` (convert JSON Schema → zod with zod 4 `z.fromJSONSchema` if available, else pass a permissive object schema and validate on the hub; record which in report). Tool full name `mcp__site__<name>`.
- `requiresConfirmation: false` tools are added to `allowedTools` (no card); `true` tools go through `canUseTool` → approval card with title = tool description, category `mcp`, target `{ command: '<name>(<args summary>)' }`.
- Skills: write `<cwd>/.claude/skills/<name>/SKILL.md` (frontmatter name/description + markdown) and `files` under that folder (paths fenced to the skill folder); `settingSources` must include `'project'` when skills exist.
- Review Focus 4: names validated (Task 2 regex) and never shadow built-ins.
- [ ] Tests: scripted query receives `mcpServers.site` and allowedTools; confirmation tool raises approval; skill files materialized and path traversal in `files[].path` rejected. Live smoke (authorized): a tool `echo_text` with requiresConfirmation false is called by Claude and its result appears; a skill's instruction is followed. Commit `feat(runtime-claude): site tools as MCP and skills`.

---

### Task 5: Hub — device login, machines, browser API (single node)

**Files:** create `packages/hub/*` (package `@uncage/hub`): `hub.ts, device.ts, machines.ts, browser-api.ts, node.ts, install-script.ts, store/{store.ts,pglite.ts}, cluster/memory.ts, index.ts`.

**Interfaces — Produces:**
```ts
export interface HubUser { id: string; name?: string }
export interface HubOptions {
  publicUrl: string;                                   // e.g. https://app.example.com
  basePath?: string;                                   // default '/api/uncage'
  getUser(req: Request): Promise<HubUser | null>;      // website auth
  store?: HubStore;                                    // default pgliteHubStore({ dataDir: './.uncage-hub' })
  cluster?: ClusterAdapter;                            // default memoryCluster()
  tools?: SiteTool[]; skills?: SkillSpec[];
  selectManifest?(ctx: { user: HubUser; prompt: string; sessionId: string }): Promise<{ tools: string[]; skills: string[] }>; // default: all
  sessionStorage?: 'machine' | 'site';                 // default 'machine'
  minAgentVersion?: string;                            // default this package's version
  cliVersionRange?: string;                            // install.sh installs @uncage/cli@<range>, default ^<major.minor>
}
export interface Hub {
  handler(req: Request): Promise<Response>;            // browser API + device endpoints + install.sh
  attach(server: import('http').Server, opts?: { path?: string /* '/api/uncage/agent' */ }): void;   // machine WebSocket
  approveDevice(userCode: string, user: HubUser): Promise<'ok' | 'not_found' | 'expired'>;
  revokeMachine(machineId: string, user: HubUser): Promise<void>;
  close(): Promise<void>;
}
export function createHub(o: HubOptions): Promise<Hub>;
export function toNodeHandler(h: Hub): (req, res, next?) => void;
```
- Browser API under `basePath`, identical paths/shapes to the daemon's `/v1` (sessions, runs, approvals, settings, attachments, events SSE, runtimes) scoped to `getUser`; plus `GET /machines` → `MachineInfo[]`, `DELETE /machines/:id`, `GET /machines/install` → `{ install: string, setup: string, windows: null }`, `POST /sessions` accepts `machineId?` (default most recently online). Machine offline → `machine_offline`.
- Device: `POST /device/code`, `POST /device/token` (poll, `intervalSec` 2, `expiresInSec` 600), user codes `XXXX-XXXX` from an unambiguous alphabet; website renders the approve page and calls `hub.approveDevice`.
- `GET /install.sh`: fixed script template (no dynamic code): checks macOS, Node ≥ 22, `claude` presence (prints install hint), runs `npm i -g @uncage/cli@<range>`, prints next step. Same script content for everyone except the version range.
- Routing: browser command → machine (via cluster) → `result`; agent `events` frames fan out to browser SSE subscribers; when `sessionStorage: 'machine'` and the browser asks for history, hub sends `readEvents` to the machine; when `'site'`, hub persists replicated events in `HubStore` and serves from it (works offline).
- Review Focus 1 & 2: offline detection (ping 25 s, offline after 2 missed), cross-user isolation tests.
- [ ] Tests with an in-process fake agent (ws client speaking Task 2 frames): device flow happy/denied/expired; machine online/offline; browser create session → command reaches fake agent; events stream to SSE; cross-user 404; site storage replay while machine offline. Commit `feat(hub): device login, machines and browser API`.

---

### Task 6: Agent daemon + CLI (setup, launchd, multi-site, policy, activity)

**Files:** create `packages/agent/*` (`@uncage/agent`); `packages/cli/src/{setup.ts, agent-cmd.ts, launchd.ts, sites.ts, activity-cmd.ts, bin.ts}`.

**Interfaces — Produces:**
```ts
export interface AgentConfig { sites: Array<{ id: string; name: string; url: string; machineId: string; token: string }>; localPolicy: { allowBypass: boolean /* false */; allowedPermissionModes?: PermissionMode[] } }
export function loadAgentConfig(home?: string): Promise<AgentConfig>;     // ~/.uncage/agent.yaml (0600)
export function createAgent(o: { config: AgentConfig; adapters: RuntimeAdapter[]; home?: string }): Promise<{ close(): Promise<void> }>;
```
- CLI: `uncage setup <url>` (device flow; opens browser via `open`; prints code + URL for headless; saves site; installs and (re)starts launchd agent `~/Library/LaunchAgents/dev.uncage.agent.plist` running `uncage agent`), `uncage agent` (foreground), `uncage sites` / `uncage sites remove <id>` (revokes on hub), `uncage activity [--site] [--follow]`, `uncage agent uninstall`.
- One process, one WS per site, exponential backoff 1 s→30 s with jitter; per-site core instance (`~/.uncage/sites/<siteId>/data`), workspace root `~/Uncage/<siteHost>/`, per-session workspace dir created on `createSession`.
- Commands executed through core; `onEvent` → `events` frames; replication backfill on reconnect from hub `ack`ed sequence (Review Focus 1).
- Tool bridge: core `callTool` → `tool_call` frame → await `tool_result` (timeout 120 s → `tool_failed`).
- `file_pull`: path must resolve inside the session workspace (Review Focus 5); cap `maxBytes` (default 50 MB total, 10 MB per file); chunk 256 KB.
- Policy: hub cannot set bypass unless `localPolicy.allowBypass`; modes outside `allowedPermissionModes` rejected with `policy_denied`; all commands + tool calls + approvals appended to `~/.uncage/sites/<siteId>/activity.log` (JSONL, redacted per export rules).
- Version: `upgrade_required` → run `npm i -g @uncage/cli@latest` once, then restart self (launchd), log it.
- [ ] Tests: agent ↔ real hub (Task 5) in-process: setup flow with programmatic approve, run with fake adapter end to end, reconnect backfill no dupes, file_pull fence + caps, policy denial, activity log written. launchd plist generation unit-tested (no real launchctl in tests). Commit `feat(agent): connected daemon and setup CLI`.

---

### Task 7: Hub — site tools execution, file channel, site storage adapters, cluster (Redis), Postgres store

**Files:** `packages/hub/src/{tools.ts, files.ts, cluster/redis.ts, store/postgres.ts}`.

**Interfaces — Produces:**
```ts
export interface ToolContext { user: HubUser; sessionId: string; runId: string; files: { pull(path: string, o?: { maxBytes?: number }): AsyncIterable<{ path: string; data: Uint8Array }>; read(path: string): Promise<Uint8Array> } }
export interface SiteTool<I = any> { name: string; description: string; input: import('zod').ZodType<I>; requiresConfirmation?: boolean; handler(args: I, ctx: ToolContext): Promise<ToolCallResult | string | object> }
export function defineTool<I>(t: SiteTool<I>): SiteTool<I>;   // input → JSON Schema via z.toJSONSchema
export interface ClusterAdapter { publish(channel: string, msg: string): Promise<void>; subscribe(channel: string, fn: (msg: string) => void): Promise<() => void>; setPresence(machineId: string, nodeId: string, ttlSec: number): Promise<void>; getPresence(machineId: string): Promise<string | null>; close(): Promise<void> }
export function memoryCluster(): ClusterAdapter;
export function redisCluster(o: { url: string } | { client: import('ioredis').Redis }): ClusterAdapter;
export interface HubStore { /* machines, device codes, sessions index, replicated events, tool-call audit */ }
export function pgliteHubStore(o: { dataDir: string }): Promise<HubStore>;
export function postgresHubStore(o: { connectionString: string } | { pool: import('pg').Pool }): Promise<HubStore>;
```
- Tool calls arriving from a machine are executed on whatever node holds the connection, with `ctx.user` = session owner (hub re-checks ownership); results/errors returned as `tool_result`; every call recorded in the store and visible as events.
- Cross-node: browser command on node B → presence lookup → publish to node A's channel → A forwards to machine → result published back; approvals single-winner remains enforced on the machine (Review Focus 3).
- [ ] Tests: two hub instances in one process sharing one `ioredis-mock` and one PGlite-backed HubStore (Postgres store tested through the same suite against PGlite via its pg-compatible driver adapter if feasible, else a pg-mem-free contract test + optional docker test in e2e); machine on A, browser on B: create session, stream events, approve once from B (exactly one decision), tool call with `ctx.files.pull` of a 3-file dir. Commit `feat(hub): site tools, file channel, Redis cluster, Postgres store`.

---

### Task 8: UI — connect machine, approve device, machine picker

**Files:** `packages/client/src/client.ts` (`machines()`, `installInfo()`, `revokeMachine()`), `packages/react/src/{store.ts,hooks.ts}` (`useMachines()`), `packages/react-ui/src/components/{ConnectMachine.tsx, ApproveDevice.tsx, MachineStatus.tsx}`, AgentChat wiring, i18n.

- `<ConnectMachine/>` = the Multica-style dialog: title "Connect your computer / 连接你的电脑", step 1 install command (macOS tab; Windows tab shows "coming soon / 即将支持"), step 2 `uncage setup <url>`, copy buttons, live "Waiting for your computer… / 等待你的电脑上线" → "Connected: <name>", collapsible "That computer can't open a browser? / 那台电脑打不开浏览器？" with the device-code instructions.
- `<ApproveDevice code=…/>` page component: shows machine name/OS and the code, Approve / Deny.
- AgentChat in connected mode: header machine status + picker; composer disabled with "Your computer is offline / 你的电脑离线了" + reconnect hint; when no machine, empty state shows ConnectMachine.
- [ ] Tests (components + store with fake client), commit `feat(ui): connect machine, approve device, machine status`.

---

### Task 9: Reference demo site + E2E (mock, multi-node, live)

**Files:** `examples/connected-demo/` (Next 16 app + `server.ts` custom Node server mounting Next + hub handler + `hub.attach`), `e2e/connected/*`.

- Demo: minimal cookie login (demo-only username form), pages `/` (chat + ConnectMachine), `/assets` (gallery), `/assets/[id]` (serves published static files in an iframe sandbox), `/device` (ApproveDevice). `sessionStorage: 'site'`. Tools: `create_asset({ title, kind: 'landing-page' })` (no confirmation), `publish_asset({ assetId, dir })` (requiresConfirmation, uses `ctx.files.pull(dir)`, stores files under the demo data dir). Skill `landing-page` (spec for a single-folder static page, index.html entry, no external CDNs).
- Multi-node mode: `HUB_NODES=2 REDIS_URL=… DATABASE_URL=…` starts two nodes behind a tiny round-robin proxy (dev script).
- E2E mock: fake agent process (agent package with fake adapter) + demo: connect via programmatic device approve, run, tool calls, asset appears; multi-node with ioredis-mock-equivalent in-process broker or docker Redis+Postgres when available (skip with logged reason otherwise).
- E2E live (authorized real Claude): run `uncage setup` against the demo (approve in browser via Playwright), daemon in foreground mode (no launchd in tests), prompt "做一个介绍 Uncage 的落地页并发布" → `create_asset` → approval card for `publish_asset` → allow → asset listed on `/assets` and its iframe shows the page; reload shows process history with machine offline (site storage).
- [ ] Write specs, implement demo, all green, record in docs/compatibility.md, commit `feat(examples): connected demo with mock, multi-node and live E2E`.

---

### Task 10: Help site (developers + coding agents)

**Files:** `apps/docs/` (Astro Starlight), `.github/workflows/docs.yml` (build + deploy to GitHub Pages — workflow committed; enabling Pages is the user's step, logged), README links.

- Content (en primary, zh-CN for Quickstart + Concepts): Overview & how it works (diagram), Quickstart Connected Mode (website side: install hub, mount, define a tool, render ConnectMachine; user side: two commands), Quickstart Local Mode, Concepts (machine, site, session, run, events, approvals, tools, skills, storage, cluster, trust model), Guides (define tools, write skills, file channel, site storage, multi-node with Redis/Postgres, auth integration, Express/Fastify/Hono/Next, custom UI with hooks, local extensions & policy), API reference generated from TS types (typedoc → markdown), Security, Troubleshooting, Changelog.
- Coding-agent friendly: every page also served as `.md`; `/llms.txt` (index) and `/llms-full.txt` (all pages concatenated); `/skills/uncage/SKILL.md` downloadable skill “Integrate Uncage into a website”; copy-paste prompts on Quickstart pages; all code samples extracted and type-checked in CI (`apps/docs/scripts/check-snippets.ts`).
- [ ] Build passes, link checker passes, snippet check passes; commit `docs: help site for developers and coding agents`.

---

### Task 11: Release prep 0.2.0 (no publish)

- Version bump to 0.2.0 for all published packages + new `@uncage/hub`, `@uncage/agent` (public, MIT, author Nathan Zhang, repository `github.com/ptmafia/uncage`, homepage = help site URL); CHANGELOG; pack dry-run inspection; fresh-dir install smoke of hub + agent from tarballs; README top-level reorganized around Connected Mode. Commit `chore(release): prepare 0.2.0`. Publishing stays the user's step (2FA browser), logged.

---

## Spec coverage map

| Spec item | Task |
|---|---|
| §2.1 接入极简 / §4.1 | 5, 6, 8 |
| §2.2 网站内指挥 / §4.2 | 3, 5, 6, 8 |
| §2.3 能力注入 / §4.3 | 2, 3, 4, 7 |
| §2.4 扩展点 / §4.4 | 3, 6, 7 |
| §2.5 参考 demo / §5 | 9 |
| §2.6 帮助站 / §8 | 10 |
| §6 安全底线, §7.1 信任模型 | 2, 5, 6, 7 |
| §10 rulings (storage truth, hub runtime, multi-node, files, extensions, multi-site, skills per session, versioning) | 5, 6, 7 |
| Demo-verification frictions F1–F6 | 1 |

---

### Task 12: CI + automatic npm release on merge (inserted at the user's request)

**Files:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.changeset/config.json`, `.changeset/README.md`, root `package.json` (scripts `changeset`, `version-packages`, `release`), `CONTRIBUTING.md` (release section), README badge.

- CI (`pull_request` + `push` to `main`/`feat/**`): pnpm 10 + Node 24 (and Node 22 matrix), `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`; `pnpm e2e:mock` with Playwright's bundled Chromium installed in CI via `pnpm exec playwright install --with-deps chromium` (CI only; local runs keep system Chrome — make the Playwright config pick `channel: 'chrome'` locally and bundled Chromium when `CI=true`). Never run `e2e:live` in CI.
- Release (`push` to `main`): Changesets action. With pending changesets → opens/updates a "Version Packages" PR. When that PR is merged → `pnpm build` then `changeset publish` to npm using **npm trusted publishing (OIDC)**: `permissions: { id-token: write, contents: write, pull-requests: write }`, npm ≥ 11.5 (`npm i -g npm@latest` in the job), `--provenance`, no `NPM_TOKEN` secret. Workflow file name must stay `release.yml` (it is what the user registers on npm).
- Changesets config: `access: public`, `baseBranch: main`, fixed/linked group so all `@uncage/*` publishable packages move together; `@uncage/testkit` ignored (private); examples/e2e/apps ignored.
- Add an initial changeset describing 0.2.0 (minor for all public packages) so the first merge of feat/connected into main produces the Version PR.
- Document the one-time user steps in CONTRIBUTING.md: for each public package on npmjs.com → Settings → Trusted publishing → GitHub Actions, org/user `ptmafia`, repo `uncage`, workflow `release.yml` (new packages @uncage/hub and @uncage/agent must be published once manually before trusted publishing can be configured, or created via the first release with a granular token — document both); repository → Settings → Actions → "Allow GitHub Actions to create and approve pull requests".
- [ ] Validate workflows with `actionlint` if available locally (skip and log otherwise); dry-run `pnpm changeset status`; commit `ci: GitHub Actions CI and Changesets release with npm trusted publishing`, push.
