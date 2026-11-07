import { z } from 'zod';
import { RuntimeInfoSchema } from './domain.js';
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
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  requiresConfirmation: z.boolean(),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

/** Relative, forward-slash, no `..`, no absolute/drive paths, no backslashes. */
const SkillFilePathSchema = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.includes('\\') &&
      !p.includes('\0') &&
      !p.startsWith('/') &&
      !/^[A-Za-z]:/.test(p) &&
      p.split('/').every((seg) => seg !== '' && seg !== '..' && seg !== '.'),
    { message: 'skill file path must be relative and must not contain "..", backslashes or empty segments' },
  );

export const SkillSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  description: z.string(),
  markdown: z.string(),
  files: z.array(z.object({ path: SkillFilePathSchema, content: z.string() })).optional(),
});
export type SkillSpec = z.infer<typeof SkillSpecSchema>;

export const SessionManifestSchema = z.object({
  tools: z.array(ToolSpecSchema),
  skills: z.array(SkillSpecSchema),
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

export const AgentFrameSchema = z.union([
  z.object({
    t: z.literal('hello'),
    protocol: z.number().int(),
    agentVersion: z.string(),
    machine: z.object({ name: z.string(), os: z.string(), runtimes: z.array(RuntimeInfoSchema) }),
  }),
  z.object({ t: z.literal('result'), id: z.string(), ok: z.literal(true), data: z.unknown() }),
  z.object({ t: z.literal('result'), id: z.string(), ok: z.literal(false), error: ErrorBodySchema }),
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
    path: z.string(),
    seq: z.number().int().nonnegative(),
    data: z.string(),
    last: z.boolean(),
  }),
  z.object({
    t: z.literal('file_done'),
    id: z.string(),
    files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() })),
  }),
  z.object({ t: z.literal('pong'), at: z.number() }),
]);
export type AgentFrame = z.infer<typeof AgentFrameSchema>;

export const HubFrameSchema = z.union([
  z.object({
    t: z.literal('welcome'),
    machineId: z.string(),
    protocol: z.number().int(),
    minAgentVersion: z.string(),
  }),
  z.object({ t: z.literal('upgrade_required'), minAgentVersion: z.string() }),
  z.object({ t: z.literal('command'), id: z.string(), op: HubCommandOpSchema, args: z.unknown() }),
  z.object({ t: z.literal('ack'), sessionId: z.string(), sequence: z.number().int() }),
  z.object({ t: z.literal('tool_result'), id: z.string(), ok: z.literal(true), result: ToolCallResultSchema }),
  z.object({ t: z.literal('tool_result'), id: z.string(), ok: z.literal(false), error: ErrorBodySchema }),
  z.object({
    t: z.literal('file_pull'),
    id: z.string(),
    sessionId: z.string(),
    path: z.string(),
    maxBytes: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal('ping'), at: z.number() }),
]);
export type HubFrame = z.infer<typeof HubFrameSchema>;

export const DeviceCodeResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
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

function parseFrame<T>(raw: string, schema: z.ZodType<T>, kind: string): T {
  if (typeof raw !== 'string') throw new ProtocolFrameError(`${kind} frame must be a string`);
  // Cheap bound first (a UTF-8 char is at most 3 bytes per UTF-16 unit), exact count only if needed.
  if (raw.length * 3 > MAX_FRAME_BYTES && new TextEncoder().encode(raw).byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolFrameError(`${kind} frame too large (max ${MAX_FRAME_BYTES} bytes)`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ProtocolFrameError(`${kind} frame is not valid JSON`);
  }
  const res = schema.safeParse(json);
  if (!res.success) {
    const t = typeof json === 'object' && json !== null ? (json as { t?: unknown }).t : undefined;
    throw new ProtocolFrameError(`invalid ${kind} frame${typeof t === 'string' ? ` "${t}"` : ''}: ${res.error.issues[0]?.message ?? 'bad shape'}`);
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
