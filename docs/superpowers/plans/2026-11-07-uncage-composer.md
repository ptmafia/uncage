# Uncage Composer (Real Capabilities) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the default composer with a Claude Code–style input box whose controls are all real: per-session model, reasoning effort, permission mode (incl. guarded bypass), attachments (images + files), browser voice input, and a "N running" chip, verified live against real Claude Code.

**Architecture:** New session settings and attachments flow protocol → core (persisted in PGlite; files on disk under the workspace) → server REST → adapters (`query()` options / Codex params) and back to the browser through client → react store/hooks → react-ui Composer. Settings apply per run (V0 starts a fresh `query()` with `resume` every run).

**Tech Stack:** existing monorepo (TS 6 pinned, Zod 4, Fastify 5, PGlite + Drizzle, React 19, Next 16, Vitest, Playwright w/ system Chrome), `@anthropic-ai/claude-agent-sdk` 0.3.318 (`model`, `effort`, `permissionMode`, `allowDangerouslySkipPermissions`, `supportedModels()`), Web Speech API.

**Spec:** `docs/superpowers/specs/2026-11-06-uncage-composer-design.md` (overrides V0 spec where they conflict) + V0 spec `docs/superpowers/specs/2026-11-06-uncage-v0-design.md`.

## Global Constraints

- All V0 global constraints still hold (loopback, token, Origin/Host checks, ESM, TS ^6.0.3 pin, `--uncage-*`/`uc-` CSS, lucide-react, locales en/zh-CN, Kumi tokens, no prompt text in info logs, `spawn`/`execFile` arg arrays).
- V0 rule "never expose bypassPermissions" is replaced by: `bypassPermissions` is accepted only when the server option `security.allowBypass === true` (config `security.allowBypass`, env `UNCAGE_ALLOW_BYPASS=1`); default false. When false it is absent from `capabilities.permissionModes` and `PATCH` with it → `policy_denied`.
- Permission modes (exact): `default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`. Effort levels (exact): `low`, `medium`, `high`, `xhigh`, `max`.
- Attachments: images `png jpg jpeg gif webp`; files `txt md json csv yaml yml xml html css js ts tsx jsx py go rs java rb sh sql log pdf`; ≤ 10 MB each (`10 * 1024 * 1024`); ≤ 10 per message; stored at `<workspace>/.uncage/attachments/<sessionId>/<attachmentId>-<safeName>`; unreferenced attachments older than 24 h are deleted by the retention job.
- Settings changes apply from the next run; a running run and its open approval cards are unaffected.
- No code-change statistics anywhere (user excluded it).
- Voice: Web Speech API only; hidden when unsupported; first use shows the privacy note.
- Running chip: all sessions on this server; `GET /v1/runs?active=1`; poll every 3 s while `document.visibilityState === 'visible'`.
- Codex: all new capabilities verified only against the fake app-server.

## Review Focus

1. **A filename with path separators, `..`, NUL, or 300+ chars** must be stored under a sanitized name inside the session's attachment dir, never escaping it. Test: Task 2.
2. **An upload whose declared Content-Type disagrees with its extension, or that exceeds 10 MB mid-stream**, is rejected (415/413) and leaves no partial file. Test: Task 3.
3. **Sending a message with attachment ids from another session or already-deleted ids** is rejected with `invalid_request`, and no run is created. Test: Task 2.
4. **Switching permission mode to bypass in one tab while `allowBypass` is off** (e.g. a crafted PATCH) returns 403 `policy_denied`; the UI never offers it. Test: Task 2 (core) + Task 8 (UI hides).
5. **Pasting an image from the clipboard and IME composition in the composer** both work: paste adds an attachment chip; Enter during IME composition still never sends. Test: Task 8.

---

## File Structure

```text
packages/protocol/src/{domain.ts, api.ts, runtime.ts, errors.ts}          (extend)
packages/core/src/{settings.ts, attachments.ts, store/migrations.ts, store/store.ts, store/pglite-store.ts, runs.ts, uncage.ts}
packages/server/src/{routes/sessions.ts, routes/attachments.ts, routes/runs.ts, proxy.ts}
packages/cli/src/{config.ts, serve.ts}
packages/runtime-claude/src/{adapter.ts, capabilities.ts, input.ts}
packages/runtime-codex/src/{adapter.ts, protocol.ts}, packages/testkit/src/fake-codex/*
packages/client/src/client.ts
packages/react/src/{store.ts, state.ts, hooks.ts, speech.ts}
packages/react-ui/src/components/{Composer.tsx, composer/*.tsx, RunningChip.tsx, BypassBanner.tsx, AttachmentList.tsx, UserMessage.tsx}, styles/components.css, i18n.ts
examples/*, e2e/mock/*, e2e/live/claude.spec.ts, README.md, docs/compatibility.md
```

---

### Task 1: Protocol extensions

**Files:** Modify `packages/protocol/src/{domain.ts, api.ts, runtime.ts, errors.ts, index.ts}`; tests `events.test.ts`, `errors.test.ts`, new `settings.test.ts`.

**Interfaces — Produces:**
```ts
export const PermissionModeSchema = z.enum(['default','acceptEdits','plan','auto','bypassPermissions']);
export const EffortLevelSchema = z.enum(['low','medium','high','xhigh','max']);
export interface ModelOption { id: string; label: string; description?: string }
// RuntimeCapabilities gains (all required; adapters fill them):
//   models: ModelOption[]; efforts: EffortLevel[]; permissionModes: PermissionMode[];
//   attachments: { images: boolean; files: boolean; maxBytes: number }
export interface SessionSettings { model?: string; effort?: EffortLevel; permissionMode: PermissionMode }   // default { permissionMode: 'default' }
// Session gains: settings: SessionSettings
export interface Attachment { id: string; sessionId: string; name: string; mime: string; size: number;
  kind: 'image' | 'file'; sha256: string; createdAt: string }
// Run gains: attachments?: Attachment[]
export const UpdateSessionSettingsBodySchema: z.ZodType<Partial<SessionSettings>>;   // at least one key
// StartRunBody becomes { prompt: string; attachmentIds?: string[] }   (max 10)
export interface ActiveRunInfo { runId: string; sessionId: string; sessionTitle: string; state: RunState; startedAt?: string }
// AdapterRunInput gains: settings: SessionSettings; attachments: ResolvedAttachment[]
export interface ResolvedAttachment extends Attachment { absPath: string }
// RuntimeAdapter gains optional: refreshCapabilities?(): Promise<RuntimeCapabilities>
// ErrorCode gains: 'attachment_too_large' (413), 'attachment_type_unsupported' (415)
export const ATTACHMENT_LIMITS = { maxBytes: 10 * 1024 * 1024, maxPerMessage: 10,
  imageExt: ['png','jpg','jpeg','gif','webp'], fileExt: [/* exactly the Global Constraints list */] } as const;
export function classifyAttachment(name: string, mime: string): 'image' | 'file' | null;   // null = unsupported
```
- `classifyAttachment`: extension (lowercased, after last dot) must be in a list; images additionally require `mime` starting `image/`; files accept any mime except `image/*` mismatches (an image extension with non-image mime → null).

- [ ] **Step 1: Write failing tests:** `classifyAttachment('a.PNG','image/png')==='image'`; `('a.png','text/plain')===null`; `('a.ts','video/mp2t')==='file'`; `('a.exe','application/octet-stream')===null`; `('noext','text/plain')===null`; `SessionSchema` rejects a session without `settings`; `StartRunBodySchema` rejects 11 attachmentIds; `UpdateSessionSettingsBodySchema` rejects `{}` and `{permissionMode:'yolo'}`; catalog has 413/415 entries with hints.
- [ ] **Step 2: Run** `pnpm --filter @uncage/protocol test` → FAIL.
- [ ] **Step 3: Implement**; then fix every compile error across the repo caused by the now-required capability fields and `Session.settings` (fake adapter, Claude/Codex capabilities, core `toSession`, fixtures) with minimal placeholder values (`models: []`, `efforts: []`, `permissionModes: ['default']`, `attachments: {images:false, files:false, maxBytes: ATTACHMENT_LIMITS.maxBytes}`, `settings: {permissionMode:'default'}`) — later tasks replace them.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(protocol): session settings, attachments and extended capabilities`

---

### Task 2: Core — settings, attachments, active runs

**Files:** Create `packages/core/src/{settings.ts, attachments.ts}`; modify `store/{migrations.ts, store.ts, pglite-store.ts}`, `runs.ts`, `uncage.ts`, `sessions.ts`, `index.ts`. Tests: `settings.test.ts`, `attachments.test.ts`, extend `uncage.test.ts`.

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
```ts
// UncageOptions gains: security?: { allowBypass?: boolean }   (default false)
// Uncage gains:
sessions.updateSettings(id: string, patch: Partial<SessionSettings>): Promise<Session>;   // emits session.updated
attachments: {
  add(sessionId: string, input: { name: string; mime: string; body: AsyncIterable<Uint8Array> | Uint8Array }): Promise<Attachment>;
  get(id: string): Promise<{ attachment: Attachment; absPath: string }>;
  pruneOrphans(olderThan: Date): Promise<number>;
};
runs.listActive(): Promise<ActiveRunInfo[]>;
// SessionHandle.startRun({ prompt, attachmentIds?, idempotencyKey? })
export function sanitizeFileName(name: string): string;   // basename only, [^\w.\- ] → '_', collapse, max 120 chars, never '' or '.'/'..'
```
- Store: migration adds `sessions.settings jsonb not null default '{"permissionMode":"default"}'`, table `attachments(id pk, session_id, name, mime, size, kind, sha256, abs_path, created_at, referenced_by_run text null)`. Store methods `createAttachment`, `getAttachment`, `listAttachments(ids)`, `markAttachmentsReferenced(ids, runId)`, `deleteOrphanAttachments(olderThan) → rows`.
- `updateSettings`: validate each key against the session's runtime capabilities (`model` ∈ `models[].id` when `models` non-empty, `effort` ∈ `efforts`, `permissionMode` ∈ `permissionModes`) → `unsupported_capability`; `bypassPermissions` when `allowBypass` false → `policy_denied` (checked first). Readonly session → `session_read_only`.
- `attachments.add`: `classifyAttachment` (null → `attachment_type_unsupported`); session's runtime `capabilities.attachments.images/files` must allow the kind; stream to `<dir>/.tmp-<id>` counting bytes, abort + delete when > maxBytes → `attachment_too_large`; compute sha256 while streaming; rename to final path; verify `realpath(final)` is inside `<workspace>/.uncage/attachments/<sessionId>/`.
- `startRun` with `attachmentIds`: all must exist, belong to this session, not be referenced yet → else `invalid_request` (no run created); after run creation mark referenced; `run.started` carries `run.attachments`; adapter receives `settings` (session's at start time) and `ResolvedAttachment[]`.
- Retention job (existing 6 h timer) also calls `pruneOrphans(now - 24h)` deleting files and rows.
- `runs.listActive`: runs in `queued|running|waiting_approval` across sessions, newest first.
- Registry: `runtimes.list()` calls `adapter.refreshCapabilities?.()` inside the existing 30 s probe cache and uses its result as the runtime's capabilities (and for new sessions' `capabilities`); errors fall back to `adapter.capabilities()`. Test: `registry uses refreshCapabilities when provided`.

- [ ] **Step 1: Write failing tests:**
  - `settings.test.ts`: `updateSettings persists and emits session.updated`; `bypass rejected with policy_denied when allowBypass false, accepted when true`; `effort not in capabilities → unsupported_capability`; `adapter receives settings at run start; later change does not affect running run`.
  - `attachments.test.ts`: `stores file under workspace/.uncage/attachments/<sid>/ with sanitized name` (names `../../etc/passwd`, `a\0b.txt`, `x/y.md`, 300×'a'+'.md' all stay inside dir) *(Review Focus 1)*; `rejects 10MB+1 with attachment_too_large and leaves no file`; `rejects .exe`; `image disallowed when capabilities.attachments.images false`; `startRun with foreign or unknown attachment id → invalid_request and no run` *(Review Focus 3)*; `startRun with already-referenced id → invalid_request`; `adapter receives ResolvedAttachment with absPath`; `pruneOrphans deletes only unreferenced older than cutoff`.
  - `uncage.test.ts`: `listActive returns active runs across sessions`.
- [ ] **Step 2: Run** `pnpm --filter @uncage/core test` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; root `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(core): session settings, attachments and active-run listing`

---

### Task 3: Server routes, proxy, CLI config

**Files:** Modify `packages/server/src/routes/{sessions.ts, runs.ts}`, create `routes/attachments.ts`, modify `app.ts`, `proxy.ts`; `packages/cli/src/{config.ts, serve.ts}`. Tests: extend `app.test.ts`, `proxy.test.ts`, `config.test.ts`.

**Interfaces — Produces (HTTP):**
| Method | Path | Body | Returns |
|---|---|---|---|
| PATCH | `/v1/sessions/:id/settings` | `UpdateSessionSettingsBody` | 200 `Session` |
| POST | `/v1/sessions/:id/attachments` | raw bytes; headers `Content-Type`, `X-Filename` (URI-encoded) | 201 `Attachment` |
| GET | `/v1/attachments/:id` | — | 200 bytes, `Content-Type`, `Content-Disposition: inline` for images else `attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=31536000, immutable` |
| GET | `/v1/runs?active=1` | — | 200 `ActiveRunInfo[]` |
| POST | `/v1/sessions/:id/runs` | `StartRunBody` (now with `attachmentIds`) | 202 `Run` |
- Attachment upload route: register a content-type parser for `*` on that route only that hands the raw request stream to `uncage.attachments.add` (Fastify `bodyLimit` for this route = maxBytes + 1 so core enforces the exact limit); `X-Filename` missing → 400.
- Proxy: forward `PATCH`; export `PATCH` from `createUncageHandler` (return `{GET, POST, PATCH}`); forward request bodies as streams with `duplex:'half'` (binary-safe); forward `X-Filename` and `Content-Type`; response passthrough already streams.
- CLI: `security.allowBypass: boolean` (default false) in `ConfigSchema`; env `UNCAGE_ALLOW_BYPASS=1` overrides to true; `serve` passes it to `createUncage({ security })` and prints `⚠ bypassPermissions enabled` in the banner when true.

- [ ] **Step 1: Write failing tests:** `PATCH settings → 200 and session.updated over SSE`; `PATCH bypass with allowBypass false → 403 policy_denied`; `upload png → 201 Attachment kind image`; `upload with mismatched type (x.png as text/plain) → 415` *(Review Focus 2)*; `upload 10MB+1 → 413 and no file in dir` *(Review Focus 2)*; `GET attachment returns bytes with nosniff`; `GET /v1/runs?active=1 lists running run`; `runs with attachmentIds → run.started carries attachments`; proxy: `PATCH forwarded`, `binary body forwarded byte-identical (random 1 MB buffer sha256 equal)`, `X-Filename forwarded`; config: `security.allowBypass default false`, `UNCAGE_ALLOW_BYPASS=1 → true`.
- [ ] **Step 2: Run** server + cli tests → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; root typecheck/lint/build.
- [ ] **Step 5: Commit** `feat(server): settings, attachments and active-runs endpoints; proxy PATCH + binary`

---

### Task 4: Claude adapter — model, effort, permission modes, attachments

**Files:** Create `packages/runtime-claude/src/{capabilities.ts, input.ts}`; modify `adapter.ts`, `index.ts`; tests `capabilities.test.ts`, `input.test.ts`, extend `adapter.contract.test.ts`; `scripts/smoke.ts`.

**Interfaces — Produces:**
```ts
export const CLAUDE_FALLBACK_MODELS: ModelOption[];   // [{id:'default',label:'Default'}] plus ids from SDK docs if present; replaced by supportedModels() when available
export function claudeCapabilities(o: { models: ModelOption[]; allowBypass: boolean }): RuntimeCapabilities;
//   efforts: ['low','medium','high','xhigh','max']; permissionModes: ['default','acceptEdits','plan','auto'] + 'bypassPermissions' iff allowBypass;
//   attachments: { images: true, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes }
export function buildPrompt(prompt: string, atts: ResolvedAttachment[]): Promise<string | AsyncIterable<SDKUserMessage>>;
//   no attachments → prompt string; else one SDKUserMessage whose content = [image blocks (base64, media_type from mime)..., text block]
//   where text = prompt + (files.length ? '\n\nAttached files (read them with your tools):\n- <absPath>\n...' : '')
// ClaudeAdapterOptions gains: allowBypass?: boolean
// adapter.refreshCapabilities(): open a short-lived streaming-input `query()` (prompt = an AsyncIterable that never yields), call `supportedModels()`, then `interrupt()` + abort; cache 10 min; on any error keep CLAUDE_FALLBACK_MODELS. No model turn is sent.
```
- `run()` passes `model: settings.model` (omit when undefined or `'default'`), `effort: settings.effort`, `permissionMode: settings.permissionMode`, and `allowDangerouslySkipPermissions: true` only when `permissionMode === 'bypassPermissions'`. `canUseTool` stays registered for every mode.
- CLI `serve` passes `allowBypass` into `claudeAdapter({ allowBypass })` (and Codex in Task 5).

- [ ] **Step 1: Write failing tests:** `capabilities omit bypass unless allowBypass`; `buildPrompt with no attachments returns string`; `buildPrompt with png + md returns one user message: image block base64 equals file bytes, text includes md absPath`; contract-adjacent `run passes model/effort/permissionMode to query options` (injected query spy); `bypass sets allowDangerouslySkipPermissions true; other modes never set it`; `refreshCapabilities falls back on error`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Live smoke (authorized):** extend `scripts/smoke.ts` with `--image <png>` and `--model`, `--permission-mode acceptEdits`: (a) image containing the text `UNCAGE-42` (generate a PNG with that text via a tiny canvas-free method: commit a fixture `fixtures/uncage-42.png` created once with macOS `sips`/`textutil` or any local tool; if none works, draw with pure JS PNG encoder in the script) → answer contains `UNCAGE-42`; (b) `acceptEdits` write → no approval requested; (c) `supportedModels()` returns ≥1 model. Record in `docs/compatibility.md`.
- [ ] **Step 6: Commit** `feat(runtime-claude): model, effort, permission modes and attachments`

---

### Task 5: Codex adapter + fake

**Files:** Modify `packages/runtime-codex/src/{adapter.ts, protocol.ts}`, `packages/testkit/src/fake-codex/{server.ts, scenarios.ts}`; tests extend `adapter.contract.test.ts`, `protocol.test.ts`.

- Capabilities: `models: [{id:'default',label:'Default'}]` (Codex has no list call in the verified schema; if the official schema has `model/list`, use it and cite), `efforts: ['low','medium','high']` (per schema; cite), `permissionModes: ['default','plan'?, 'bypassPermissions' iff allowBypass]` — include only modes mappable per schema: `default`→`approvalPolicy:'on-request', sandbox:'workspace-write'`; `acceptEdits`→ omit unless schema has an equivalent; `bypassPermissions`→`approvalPolicy:'never', sandbox:'danger-full-access'`. `attachments: { images: true, files: true }`.
- `turn/start` params gain `model`, `effort` (field names per official schema, cited in protocol.ts), and per-turn `approvalPolicy`/`sandboxPolicy`; images → `{type:'localImage', path: absPath}` inputs before the text; files → paths appended to text like Claude.
- Fake records received `turn/start` params (existing `FAKE_CODEX_TRACE`).

- [ ] **Step 1: Write failing tests:** `turn/start carries model/effort/approvalPolicy from settings`; `bypass maps to never + danger-full-access`; `image attachment sent as localImage before text`; `capabilities omit bypass unless allowBypass`.
- [ ] **Step 2–4:** RED → implement → GREEN.
- [ ] **Step 5: Commit** `feat(runtime-codex): settings and attachments (mock-verified)`

---

### Task 6: Client

**Files:** Modify `packages/client/src/client.ts`, `index.ts`; test `client.test.ts`.

**Interfaces — Produces (added to `UncageClient`):**
```ts
updateSettings(sessionId: string, patch: Partial<SessionSettings>): Promise<Session>;
uploadAttachment(sessionId: string, file: Blob & { name: string }, opts?: { signal?: AbortSignal }): Promise<Attachment>;
attachmentUrl(attachmentId: string): string;   // `${baseUrl}/attachments/${id}`
listActiveRuns(): Promise<ActiveRunInfo[]>;
startRun(sessionId: string, b: StartRunBody): Promise<Run>;   // now forwards attachmentIds
```
- Upload sends `body: file`, `Content-Type: file.type || 'application/octet-stream'`, `X-Filename: encodeURIComponent(file.name)`.

- [ ] Steps: failing tests (`updateSettings uses PATCH`, `upload sends raw blob + headers and parses Attachment`, `413 → UncageClientError attachment_too_large`, `listActiveRuns GET /runs?active=1`) → implement → pass → commit `feat(client): settings, attachments and active runs`.

---

### Task 7: React store + hooks

**Files:** Modify `packages/react/src/{state.ts, store.ts, hooks.ts, apply-event.ts, index.ts}`, create `speech.ts`; tests extend `store.test.ts`, `hooks.test.tsx`, new `speech.test.ts`.

**Interfaces — Produces:**
```ts
export interface DraftAttachment { localId: string; name: string; size: number; kind: 'image'|'file'|null;
  previewUrl?: string; status: 'uploading'|'ready'|'error'; attachment?: Attachment; error?: UncageClientError }
export function useSessionSettings(): { settings: SessionSettings; capabilities?: RuntimeCapabilities;
  update(patch: Partial<SessionSettings>): Promise<boolean>; pendingForNextRun: boolean };
//   no session yet → edits a draft settings object applied right after createSession (before sendPrompt)
export function useAttachments(): { items: DraftAttachment[]; add(files: File[]): void; remove(localId: string): void;
  clear(): void; ready: boolean; rejected: Array<{ name: string; reason: 'type'|'size'|'count' }> };
//   validates with classifyAttachment + ATTACHMENT_LIMITS client-side before upload; no session yet → files queue and upload right after createSession
export function useSpeechInput(o: { lang: string; onText(text: string, final: boolean): void }):
  { supported: boolean; listening: boolean; start(): void; stop(): void; error?: string };
export function useRunningSessions(): { runs: ActiveRunInfo[]; count: number };
export function useAttachmentUrl(attachmentId: string): string;   // client.attachmentUrl via the store's client   // polls listActiveRuns every 3 s while visible; refreshes on local run events
// store.actions.sendPrompt(prompt) now sends ready attachments' ids and clears them on success (still resolves boolean)
```
- `pendingForNextRun` = settings changed while a run is active.
- `speech.ts` wraps `window.SpeechRecognition ?? window.webkitSpeechRecognition`; `interimResults: true`; `continuous: true`; stops on unmount.

- [ ] **Step 1: Failing tests:** `draft settings applied to new session before first run`; `update during active run sets pendingForNextRun`; `attachments: oversize/unsupported rejected client-side without upload`; `11th file rejected with reason count`; `sendPrompt sends attachmentIds and clears drafts on success, keeps them on failure`; `useRunningSessions polls and stops when hidden` (fake timers + visibilitychange); `useSpeechInput supported=false without API; with a fake recognizer emits interim then final text`.
- [ ] **Steps 2–4**; **Step 5: Commit** `feat(react): settings, attachments, speech and running-sessions hooks`

---

### Task 8: React-UI — Claude Code–style composer

**Files:** Rewrite `packages/react-ui/src/components/Composer.tsx`; create `components/composer/{ModelMenu.tsx, EffortMenu.tsx, PermissionMenu.tsx, AttachButton.tsx, MicButton.tsx, Popover.tsx}`, `RunningChip.tsx`, `BypassBanner.tsx`, `AttachmentList.tsx`; modify `UserMessage.tsx`, `AgentChat.tsx`, `i18n.ts`, `styles/components.css`; tests extend `components.test.tsx`.

Visual spec (screenshot from the user, mapped onto Kumi tokens):
- Above the box, left-aligned chips row: `RunningChip` ("N running" / "N 个运行中", blue dot `--uncage-accent-ink`, pill `rounded-full`, border-soft, hidden when 0; click opens a popover list of running sessions → select).
- Box: `border-radius: 18px` (xl), surface bg, border-strong, composer shadow, padding 14px 16px 10px; textarea first (placeholder `Message {runtime}, attach files…` / `给 {runtime} 发消息，可添加附件…`); attachment chips row (thumbnail 40px for images with `object-fit: cover`, file icon + name + size, × remove, spinner while uploading, red border on error) between textarea and toolbar.
- Toolbar left→right: `+` (AttachButton, opens file picker, `multiple`, `accept` from limits), ModelMenu (sparkle icon + label + chevron), EffortMenu (brain icon + label), PermissionMenu (shield icon + label), all ghost buttons `h-8 text-ui text-ink-2`; right side: run indicator (spinner ring while active), MicButton (hidden when unsupported; pulsing ring while listening; reduced-motion respected), Send/Stop: Send = ink circle 32px with ArrowUp; Stop = **red** circle (`--uncage-err-fg` bg, white square) 32px.
- Menus: `Popover` (no deps): `role="menu"`, arrow-key navigation, Esc closes, click-outside closes; items show label + description + check for current; a "Applies to the next run" / "下一次运行生效" footnote when `pendingForNextRun`.
- Permission labels: default "Ask every time / 每次询问", acceptEdits "Accept edits / 自动接受编辑", plan "Plan mode / 计划模式", auto "Auto mode / 自动模式", bypassPermissions "Bypass permissions / 完全放行" (err color). Choosing bypass opens a confirm dialog ("Agent will run any command without asking. Continue?" / "Agent 将不经询问执行任何命令，确定开启？", buttons Cancel/Enable · 取消/开启); `BypassBanner` (err-surface, err-border, ShieldAlert icon) shown at top of conversation while the session mode is bypass.
- Drag-and-drop over the box: accent-soft overlay "Drop files to attach / 松开以添加附件"; paste of image files adds attachments.
- Mic first use: one-time note (localStorage key `uncage.speechNoticeShown`) "Audio is processed by your browser vendor's speech service." / "语音由浏览器厂商的语音服务处理。"
- Rejections show inline caption under the box ("Unsupported file type: x.exe" / "不支持的文件类型：x.exe"; size; count).
- `UserMessage` renders attachments: image thumbnails (via `useAttachmentUrl(id)` from Task 7) and file chips.
- Controls hidden when the capability list is empty (e.g., efforts []).

- [ ] **Step 1: Failing tests:** `toolbar renders model/effort/permission from capabilities`; `selecting model calls update and shows label`; `bypass hidden when not in permissionModes` *(Review Focus 4)*; `choosing bypass requires confirm; cancel keeps mode`; `BypassBanner shows when mode bypass`; `paste image adds attachment chip` *(Review Focus 5)*; `Enter during IME composition never sends (regression)` *(Review Focus 5)*; `drop files adds chips; unsupported shows caption`; `Stop button is red-styled class uc-stop`; `mic hidden without SpeechRecognition; with fake shows and fills text`; `RunningChip shows count and hides at 0`; `menus keyboard: ArrowDown/Enter selects, Esc closes`; zh-CN copy for the five permission labels.
- [ ] **Steps 2–4**; visual self-check: render AgentChat in the default example, screenshot light+dark via Playwright system Chrome, compare against the screenshot description, delete images.
- [ ] **Step 5: Commit** `feat(react-ui): Claude Code-style composer with real controls`

---

### Task 9: Examples, E2E (mock + live), docs

**Files:** `examples/react-headless-chat/app/Chat.tsx` (add model, permission mode, attachments via hooks), `e2e/mock/composer.spec.ts`, `e2e/live/claude.spec.ts` (new specs), `e2e/live/fixture-repo/notes.md`, `e2e/fixtures/uncage-42.png` (reuse Task 4 fixture), `README.md`, `docs/compatibility.md`, `packages/react-ui/README.md`.

- Mock e2e (fake adapter extended to echo received settings/attachment names in its text): model/effort/permission selection reaches the adapter (assert echoed text); upload image + file then send → user bubble shows thumbnail + chip, echoed names; reload keeps them; bypass not offered when server allowBypass false; with allowBypass server (second mock server port) bypass requires confirm and shows banner; running chip shows 1 during `slow` run and jumps to the session; 11 files → count rejection.
- Live e2e (real Claude, authorized), assertions on states except where noted:
  1. Model menu lists ≥1 model from `supportedModels()`; pick a non-default model; run completes (assert run completed).
  2. Effort `low` then run completes.
  3. `acceptEdits`: "create file a.txt with hello" → no approval card, file exists.
  4. `plan`: same prompt → no file created, run completes.
  5. `default`: Bash command → approval card appears (regression).
  6. Image attachment `uncage-42.png` + "What text is in the image?" → assistant text contains `UNCAGE-42`.
  7. File attachment `notes.md` (contains `the secret word is marmalade`) + "What is the secret word in the attached file?" → contains `marmalade`.
  8. With `UNCAGE_ALLOW_BYPASS=1` server: bypass after confirm → Bash runs with no approval card, banner visible.
  9. `auto`: run completes or fails with `unsupported_capability` (either recorded in compatibility.md).
  10. Running chip shows 1 during a run in another session.
- Voice: manual check recorded in `docs/compatibility.md` (Chrome: mic → speak → text appears); mock e2e covers UI with a fake recognizer injected via `page.addInitScript`.
- README: composer section (controls, allowBypass config/env + warning, attachments limits/location + suggest adding `.uncage/` to `.gitignore`, voice privacy note).
- [ ] Steps: write specs → run `pnpm e2e:mock` → implement example changes → pass → `UNCAGE_LIVE=1 pnpm e2e:live` all pass → docs → final `pnpm typecheck && pnpm lint && pnpm build && pnpm test && pnpm e2e:mock` → commit `test(e2e): composer controls mock + live; docs`.

---

## Spec coverage map

| Spec item | Task |
|---|---|
| §2.1 model | 1, 2, 4, 7, 8, 9 |
| §2.2 effort | 1, 2, 4, 7, 8, 9 |
| §2.3 permission modes + bypass guard | 1, 2, 3, 4, 5, 8, 9 |
| §2.4 attachments | 1, 2, 3, 4, 5, 6, 7, 8, 9 |
| §2.5 voice | 7, 8, 9 |
| §2.6 running chip | 2, 3, 6, 7, 8, 9 |
| §2.7 stop/send look | 8 |
| §2.8 headless | 7, 9 |
| §4.1 rulings (next-run, auto, allowBypass, storage, migrations, types, scope, Codex) | 2, 3, 4, 5 |
