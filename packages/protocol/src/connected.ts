import { z } from 'zod';
import { SessionSnapshotSchema, StartRunBodySchema, UpdateSessionSettingsBodySchema } from './api.js';
import { ApprovalDecisionSchema, ApprovalRequestSchema, AttachmentSchema, RunSchema, RuntimeInfoSchema, SessionSchema } from './domain.js';
import { ErrorBodySchema, type ErrorCode } from './errors.js';
import { UncageEventSchema } from './events.js';

/** Connected-mode wire protocol version. */
export const CONNECTED_PROTOCOL = 1;
/** Maximum size of a single hub/agent frame, in UTF-8 bytes. */
export const MAX_FRAME_BYTES = 1_048_576;

export const MachineInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  os: z.string(),
  agentVersion: z.string(),
  runtimes: z.array(RuntimeInfoSchema),
  online: z.boolean(),
  lastSeenAt: z.string(),
});
export type MachineInfo = z.infer<typeof MachineInfoSchema>;

export const ToolSpecSchema = z.object({
  // No `__`: reserved for runtime-namespaced names such as `mcp__server__tool`.
  name: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/).refine((n) => !n.includes('__'), { message: 'tool name must not contain "__"' }),
  description: z.string().max(1000),
  inputSchema: z
    .record(z.string(), z.unknown())
    .refine((o) => JSON.stringify(o).length <= 64 * 1024, { message: 'inputSchema too large' }),
  requiresConfirmation: z.boolean(),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Relative, forward-slash path. Nothing is ever decoded: `%2e%2e` is a literal
 * (harmless) file name, not `..`. Consumers must still realpath-fence on disk.
 */
export const RelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f\\:]/.test(p) &&
      !p.startsWith('/') &&
      p.split('/').every(
        (seg) =>
          seg.trim() !== '' &&
          seg !== '.' &&
          seg !== '..' &&
          !/[. ]$/.test(seg) &&
          !WINDOWS_RESERVED.test(seg.split('.')[0] ?? ''),
      ),
    { message: 'invalid relative path' },
  );
export type RelativePath = z.infer<typeof RelativePathSchema>;

const MAX_TEXT = 256 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PULL_BYTES = 50 * 1024 * 1024;
/** base64 chars for a 256 KiB chunk. */
const MAX_CHUNK_B64 = 349_528;

export const SkillSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  description: z.string().max(1000),
  markdown: z.string().max(MAX_TEXT),
  files: z
    .array(z.object({ path: RelativePathSchema, content: z.string().max(MAX_TEXT) }))
    .max(200)
    .refine((fs) => new Set(fs.map((f) => f.path.toLowerCase())).size === fs.length, {
      message: 'duplicate skill file path',
    })
    .optional(),
});
export type SkillSpec = z.infer<typeof SkillSpecSchema>;

/** Most tools / skills one session manifest may carry. */
export const MAX_MANIFEST_TOOLS = 64;
export const MAX_MANIFEST_SKILLS = 64;

export const SessionManifestSchema = z.object({
  tools: z.array(ToolSpecSchema).max(MAX_MANIFEST_TOOLS),
  skills: z.array(SkillSpecSchema).max(MAX_MANIFEST_SKILLS),
});
export type SessionManifest = z.infer<typeof SessionManifestSchema>;

export const HubCommandOpSchema = z.enum([
  'createSession',
  'startRun',
  'cancelRun',
  'decide',
  'updateSettings',
  'addAttachment',
  'snapshot',
  'listSessions',
  'readEvents',
]);
export type HubCommandOp = z.infer<typeof HubCommandOpSchema>;

const IdempotencyKeySchema = z.string().min(1).max(256);
const Base64Schema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
/** Most events one `readEvents` command returns. */
export const MAX_READ_EVENTS = 500;

/**
 * `args` of each hub → agent `command`, by op. The agent validates these before acting; the
 * session workspace is always chosen by the agent, never by the hub.
 */
export const HubCommandArgsSchemas = {
  createSession: z.object({ runtime: z.string().min(1), title: z.string().optional() }),
  startRun: StartRunBodySchema.extend({
    sessionId: z.string(),
    idempotencyKey: IdempotencyKeySchema,
    manifest: SessionManifestSchema,
  }),
  cancelRun: z.object({ runId: z.string() }),
  decide: z.object({ approvalId: z.string(), decision: ApprovalDecisionSchema, idempotencyKey: IdempotencyKeySchema }),
  updateSettings: z.object({ sessionId: z.string(), patch: UpdateSessionSettingsBodySchema }),
  addAttachment: z.object({ sessionId: z.string(), name: z.string().min(1), mime: z.string().min(1), data: Base64Schema }),
  snapshot: z.object({ sessionId: z.string() }),
  listSessions: z.object({}),
  readEvents: z.object({
    sessionId: z.string(),
    after: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(MAX_READ_EVENTS),
  }),
} satisfies Record<HubCommandOp, z.ZodType>;
export type HubCommandArgs = { [K in HubCommandOp]: z.infer<(typeof HubCommandArgsSchemas)[K]> };

/** `data` of a successful `result` for each op (same shapes as the daemon API responses). */
export const HubCommandResultSchemas = {
  createSession: SessionSchema,
  startRun: RunSchema,
  cancelRun: RunSchema,
  decide: ApprovalRequestSchema,
  updateSettings: SessionSchema,
  addAttachment: AttachmentSchema,
  snapshot: SessionSnapshotSchema,
  listSessions: z.array(SessionSchema),
  readEvents: z.array(UncageEventSchema).max(MAX_READ_EVENTS),
} satisfies Record<HubCommandOp, z.ZodType>;
export type HubCommandResults = { [K in HubCommandOp]: z.infer<(typeof HubCommandResultSchemas)[K]> };

export const ToolCallResultSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('json'), json: z.unknown() }),
    ]),
  ),
  isError: z.boolean().optional(),
});
export type ToolCallResult = z.infer<typeof ToolCallResultSchema>;

export const AgentFrameSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    protocol: z.number().int().positive(),
    agentVersion: z.string(),
    machine: z.object({ name: z.string(), os: z.string(), runtimes: z.array(RuntimeInfoSchema) }),
  }),
  z.discriminatedUnion('ok', [
    z.object({ t: z.literal('result'), id: z.string(), ok: z.literal(true), data: z.unknown() }),
    z.object({ t: z.literal('result'), id: z.string(), ok: z.literal(false), error: ErrorBodySchema }),
  ]),
  z.object({ t: z.literal('events'), sessionId: z.string(), events: z.array(UncageEventSchema) }),
  z.object({
    t: z.literal('tool_call'),
    id: z.string(),
    sessionId: z.string(),
    runId: z.string(),
    tool: z.string(),
    args: z.unknown(),
  }),
  z.object({
    t: z.literal('file_chunk'),
    id: z.string(),
    path: RelativePathSchema,
    seq: z.number().int().min(0).max(100_000),
    data: z.string().max(MAX_CHUNK_B64).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    last: z.boolean(),
  }),
  z.object({
    t: z.literal('file_done'),
    id: z.string(),
    files: z
      .array(z.object({ path: RelativePathSchema, size: z.number().int().min(0).max(MAX_FILE_BYTES) }))
      .max(10_000),
  }),
  z.object({ t: z.literal('pong'), at: z.number() }),
]);
export type AgentFrame = z.infer<typeof AgentFrameSchema>;

export const HubFrameSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('welcome'),
    machineId: z.string(),
    protocol: z.number().int(),
    minAgentVersion: z.string(),
  }),
  z.object({ t: z.literal('upgrade_required'), minAgentVersion: z.string() }),
  z.object({ t: z.literal('command'), id: z.string(), op: HubCommandOpSchema, args: z.unknown() }),
  z.object({ t: z.literal('ack'), sessionId: z.string(), sequence: z.number().int() }),
  z.discriminatedUnion('ok', [
    z.object({ t: z.literal('tool_result'), id: z.string(), ok: z.literal(true), result: ToolCallResultSchema }),
    z.object({ t: z.literal('tool_result'), id: z.string(), ok: z.literal(false), error: ErrorBodySchema }),
  ]),
  z.object({
    t: z.literal('file_pull'),
    id: z.string(),
    sessionId: z.string(),
    path: RelativePathSchema,
    maxBytes: z.number().int().min(1).max(MAX_PULL_BYTES),
  }),
  z.object({ t: z.literal('ping'), at: z.number() }),
]);
export type HubFrame = z.infer<typeof HubFrameSchema>;

export const DeviceCodeResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  verificationUri: z.string().refine((u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } }, { message: 'must be http(s) URL' }),
  intervalSec: z.number(),
  expiresInSec: z.number(),
});
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>;

export const DeviceTokenResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('ok'),
    machineId: z.string(),
    machineToken: z.string(),
    site: z.object({ id: z.string(), name: z.string(), url: z.string() }),
  }),
]);
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;

/**
 * Thrown by `parseAgentFrame` / `parseHubFrame` on any malformed frame
 * (oversized, not JSON, unknown `t`, bad shape). `code` is always `invalid_request`.
 */
export class ProtocolFrameError extends Error {
  readonly code: ErrorCode = 'invalid_request';
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolFrameError';
  }
}

const MAX_DEPTH = 64;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Bracket-depth scan (string-aware) so deep nesting is rejected before JSON.parse recurses. */
function exceedsDepth(raw: string): boolean {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') {
      if (++depth > MAX_DEPTH) return true;
    } else if (c === '}' || c === ']') depth--;
  }
  return false;
}

const clip = (v: string): string => (v.length > 64 ? `${v.slice(0, 64)}...` : v);

function parseFrame<T>(raw: string, schema: z.ZodType<T>, kind: string): T {
  if (typeof raw !== 'string') throw new ProtocolFrameError(`${kind} frame must be a string`);
  // Cheap bound first (a UTF-8 char is at most 3 bytes per UTF-16 unit), exact count only if needed.
  if (raw.length * 3 > MAX_FRAME_BYTES && new TextEncoder().encode(raw).byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolFrameError(`${kind} frame too large (max ${MAX_FRAME_BYTES} bytes)`);
  }
  if (exceedsDepth(raw)) throw new ProtocolFrameError(`${kind} frame nested too deeply (max ${MAX_DEPTH})`);
  let json: unknown;
  try {
    json = JSON.parse(raw, (k, v: unknown) => (FORBIDDEN_KEYS.has(k) ? undefined : v));
  } catch {
    throw new ProtocolFrameError(`${kind} frame is not valid JSON`);
  }
  const res = schema.safeParse(json);
  if (!res.success) {
    const t = typeof json === 'object' && json !== null ? (json as { t?: unknown }).t : undefined;
    throw new ProtocolFrameError(`invalid ${kind} frame${typeof t === 'string' ? ` "${clip(t)}"` : ''}: ${clip(res.error.issues[0]?.message ?? 'bad shape')}`);
  }
  return res.data;
}

/** Parse a raw agent→hub frame. Throws `ProtocolFrameError` (`code: 'invalid_request'`). */
export function parseAgentFrame(raw: string): AgentFrame {
  return parseFrame(raw, AgentFrameSchema, 'agent');
}

/** Parse a raw hub→agent frame. Throws `ProtocolFrameError` (`code: 'invalid_request'`). */
export function parseHubFrame(raw: string): HubFrame {
  return parseFrame(raw, HubFrameSchema, 'hub');
}
