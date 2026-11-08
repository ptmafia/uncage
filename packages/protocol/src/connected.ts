import { z } from 'zod';
import { SessionSnapshotSchema, StartRunBodySchema, UpdateSessionSettingsBodySchema } from './api.js';
import { ApprovalDecisionSchema, ApprovalRequestSchema, AttachmentSchema, RunSchema, RuntimeInfoSchema, SessionSchema } from './domain.js';
import { ErrorBodySchema } from './errors.js';
import { parseFrame } from './frame-parse.js';
import { UncageEventSchema } from './events.js';

export { MAX_FRAME_BYTES, ProtocolFrameError } from './frame-parse.js';

/** Connected-mode wire protocol version. */
export const CONNECTED_PROTOCOL = 2;
/** Oldest agent a hub accepts by default (`minAgentVersion`). */
export const MIN_AGENT_VERSION = '0.3.0';

/** How a machine is linked to the hub: WebSocket (traditional mode) or resumable HTTP streaming (FaaS mode). */
export const TransportKindSchema = z.enum(['ws', 'http']);
export type TransportKind = z.infer<typeof TransportKindSchema>;

/** A transport the hub offers. `url` is `ws(s)://` for `ws` and `http(s)://` for `http`. */
export const TransportOfferSchema = z.object({ kind: TransportKindSchema, url: z.string() });
export type TransportOffer = z.infer<typeof TransportOfferSchema>;

/** What the hub tells agents about itself: protocol, oldest accepted agent, and the transports it serves. */
export const AgentInfoSchema = z.object({
  protocol: z.number().int(),
  minAgentVersion: z.string(),
  transports: z.array(TransportOfferSchema).min(1),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const MachineInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  os: z.string(),
  agentVersion: z.string(),
  runtimes: z.array(RuntimeInfoSchema),
  online: z.boolean(),
  lastSeenAt: z.string(),
  /** The machine's agent is older than the hub's `minAgentVersion`: the website should ask the user to upgrade. */
  agentOutdated: z.boolean(),
  /** Transport of the live link, `null` while offline. */
  transport: TransportKindSchema.nullable(),
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
/** Raw bytes per `file_chunk` / `attachment_chunk` (256 KiB). */
export const FILE_CHUNK_BYTES = 256 * 1024;
/** base64 chars for a 256 KiB chunk. */
const MAX_CHUNK_B64 = 349_528;
/** Largest attachment the chunked hub → agent transfer carries (the attachment limit, 10 MiB). */
export const MAX_ATTACHMENT_TRANSFER_BYTES = MAX_FILE_BYTES;
const ChunkDataSchema = z
  .string()
  .max(MAX_CHUNK_B64)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

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

/** Upper bound on hub-sent run warnings. */
export const MAX_RUN_WARNINGS = 8;
/** A notice the hub attaches to a run; shown in the session as a `system.warning` event. */
export const RunWarningSchema = z.object({ code: z.string().min(1).max(64), message: z.string().max(1000) });
export type RunWarning = z.infer<typeof RunWarningSchema>;

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
  /** `id`: chosen by the hub so it can recognise the session's events (the machine falls back to its own). */
  createSession: z.object({ runtime: z.string().min(1), title: z.string().optional(), id: z.string().regex(/^ses_[a-z0-9]{8,64}$/).optional() }),
  startRun: StartRunBodySchema.extend({
    sessionId: z.string(),
    idempotencyKey: IdempotencyKeySchema,
    manifest: SessionManifestSchema,
    /** Notices the machine records as `system.warning` events on the run (e.g. `site_tools_unsupported`). */
    warnings: z.array(RunWarningSchema).max(MAX_RUN_WARNINGS).optional(),
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
    transport: TransportKindSchema,
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
    data: ChunkDataSchema,
    last: z.boolean(),
  }),
  z.object({
    t: z.literal('file_done'),
    id: z.string(),
    files: z
      .array(z.object({ path: RelativePathSchema, size: z.number().int().min(0).max(MAX_FILE_BYTES) }))
      .max(10_000),
    /**
     * Files a directory pull left out, each with a short reason (e.g. more than one hard link).
     * Their bytes were never read.
     */
    skipped: z
      .array(z.object({ path: RelativePathSchema, reason: z.string().max(500) }))
      .max(10_000)
      .optional(),
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
  /**
   * Chunked attachment upload (hub → agent) for attachments too large for one `addAttachment`
   * command: `attachment_begin`, then `attachment_chunk`s (`seq` from 0, 256 KiB raw each), then
   * `attachment_end`. The agent answers with a `result` frame for `id` (data: the `Attachment`), or
   * an error `result` at any point (later chunks for that id are ignored). `attachment_abort`
   * drops a transfer; so does the connection closing.
   */
  z.object({
    t: z.literal('attachment_begin'),
    id: z.string().min(1).max(128),
    sessionId: z.string(),
    name: z.string().min(1).max(1024),
    mime: z.string().min(1).max(255),
    size: z.number().int().min(0).max(MAX_ATTACHMENT_TRANSFER_BYTES),
  }),
  z.object({
    t: z.literal('attachment_chunk'),
    id: z.string().min(1).max(128),
    seq: z.number().int().min(0).max(100_000),
    data: ChunkDataSchema,
  }),
  z.object({ t: z.literal('attachment_end'), id: z.string().min(1).max(128) }),
  z.object({ t: z.literal('attachment_abort'), id: z.string().min(1).max(128) }),
  z.object({ t: z.literal('ping'), at: z.number() }),
]);
export type HubFrame = z.infer<typeof HubFrameSchema>;

/**
 * Body of `POST <hub>/device/code`. `machineKey` is a random 32-byte id (base64url) the agent
 * keeps locally: re-pairing the same machine for the same user reuses its machine id (sessions stay
 * visible) and rotates its token instead of creating a new machine.
 */
export const DeviceCodeRequestSchema = z.object({
  name: z.string().max(200).optional(),
  os: z.string().max(200).optional(),
  machineKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
});
export type DeviceCodeRequest = z.infer<typeof DeviceCodeRequestSchema>;

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
  /** Polled faster than `intervalSec`: wait longer between polls (RFC 8628 `slow_down`). */
  z.object({ status: z.literal('slow_down') }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
  z.object({
    status: z.literal('ok'),
    machineId: z.string(),
    machineToken: z.string(),
    site: z.object({ id: z.string(), name: z.string(), url: z.string() }),
    /** Transports this hub serves; the agent prefers `ws` and falls back to `http`. */
    transports: z.array(TransportOfferSchema).min(1),
  }),
]);
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;

/** Parse a raw agent→hub frame. Throws `ProtocolFrameError` (`code: 'invalid_request'`). */
export function parseAgentFrame(raw: string): AgentFrame {
  return parseFrame(raw, AgentFrameSchema, 'agent');
}

/** Parse a raw hub→agent frame. Throws `ProtocolFrameError` (`code: 'invalid_request'`). */
export function parseHubFrame(raw: string): HubFrame {
  return parseFrame(raw, HubFrameSchema, 'hub');
}
