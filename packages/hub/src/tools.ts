import { UncageError } from '@uncage/core/errors';
import { ToolCallResultSchema, ToolSpecSchema, type ToolCallResult, type ToolSpec } from '@uncage/protocol';
import { z } from 'zod';
import type { FilePull } from './files.js';
import type { HubUser } from './types.js';

export interface ToolContext {
  /** The session's owner: the hub re-checks that the session belongs to this machine and user. */
  user: HubUser;
  sessionId: string;
  runId: string;
  /**
   * Aborted when the call is abandoned: it timed out (120 s by default), the run ended, or the
   * machine disconnected. Pass it on to your own I/O.
   */
  signal: AbortSignal;
  /** Files from the session workspace on the machine (the file channel). */
  files: {
    /**
     * Every file under `path` (a file or directory relative to the session workspace), at most
     * `maxBytes` in total (default and maximum 50 MiB; 10 MiB per file). All-or-nothing: see
     * `FilePull`. Symlinks are never followed; hard-linked files in a directory are skipped and
     * listed in `skipped`.
     */
    pull(path: string, o?: { maxBytes?: number }): FilePull;
    /** One file's bytes (at most 10 MiB). Rejects for a directory. */
    read(path: string): Promise<Uint8Array>;
  };
}

/**
 * A website capability offered to the agent as an MCP tool. It executes on the hub node that holds
 * the machine's connection, as the session's owner (`ctx.user`); the machine only ever receives its
 * name, description and JSON Schema.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SiteTool<I = any> {
  /** `^[a-z][a-z0-9_]{0,47}$`, no `__`. */
  name: string;
  description: string;
  /** Arguments are validated (and parsed: defaults, transforms) with this before `handler` runs. */
  input: z.ZodType<I>;
  /** When true the user confirms each call in the website UI first. */
  requiresConfirmation?: boolean;
  /**
   * Returns a `ToolCallResult`, a string (→ one text block) or any other JSON value (→ one json
   * block). A throw becomes a `tool_failed` error carrying its message, which the user and the
   * model see: throw user-safe messages (no stack traces, SQL or secrets).
   */
  handler(args: I, ctx: ToolContext): Promise<ToolCallResult | string | object>;
}

/**
 * Declares a site tool, keeping the handler's `args` typed from `input`. Its `input` is turned
 * into JSON Schema (`z.toJSONSchema`) for the machine.
 *
 * @example
 * const lookupOrder = defineTool({
 *   name: 'lookup_order',
 *   description: 'Look up one of the signed-in user\'s orders',
 *   input: z.object({ id: z.string() }),
 *   handler: async ({ id }, ctx) => db.orders.find({ id, userId: ctx.user.id }),
 * });
 */
export function defineTool<I>(t: SiteTool<I>): SiteTool<I> {
  return t;
}

/** The declarative spec sent to machines (input → JSON Schema). Throws on an invalid tool. */
export function toToolSpec(t: SiteTool): ToolSpec {
  const r = ToolSpecSchema.safeParse({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>,
    requiresConfirmation: t.requiresConfirmation ?? false,
  });
  if (!r.success) throw new Error(`Invalid site tool "${t.name}": ${r.error.issues[0]?.message ?? 'bad shape'}`);
  return r.data;
}

/** A handler's return value as a `ToolCallResult`. */
export function normalizeToolResult(v: unknown): ToolCallResult {
  if (v === undefined || v === null) return { content: [] };
  if (typeof v === 'string') return { content: [{ type: 'text', text: v }] };
  if (typeof v === 'object' && !Array.isArray(v) && 'content' in v) {
    const r = ToolCallResultSchema.safeParse(v);
    if (r.success) return r.data;
  }
  return { content: [{ type: 'json', json: v }] };
}

/** A tool call from a machine, already checked to belong to `user`'s session on that machine. */
export interface ToolCallRequest {
  user: HubUser;
  machineId: string;
  sessionId: string;
  runId: string;
  tool: string;
  args: unknown;
  /** The machine's `tool_call` id. */
  callId?: string;
}

/** Seam for executing site tools on the hub node that holds the machine connection. */
export interface ToolExecutor {
  execute(call: ToolCallRequest, ctx: Pick<ToolContext, 'signal' | 'files'>): Promise<ToolCallResult>;
}

const MAX_ERROR_MESSAGE = 2000;

const issuesText = (issues: readonly z.core.$ZodIssue[]): string =>
  issues
    .slice(0, 5)
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');

/**
 * Runs `SiteTool`s: validates args with the tool's zod `input` (`invalid_request` when they do not
 * match — the agent may have used a permissive schema), calls the handler, normalizes its result.
 * Handler throws become `tool_failed` with the thrown message.
 */
export function siteToolExecutor(tools: readonly SiteTool[]): ToolExecutor {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    async execute(call, ctx) {
      const tool = byName.get(call.tool);
      if (!tool) throw new UncageError('tool_failed', { message: `Unknown site tool "${call.tool}".` });
      const parsed = await tool.input.safeParseAsync(call.args);
      if (!parsed.success) {
        throw new UncageError('invalid_request', {
          message: `Invalid arguments for site tool "${tool.name}": ${issuesText(parsed.error.issues)}`,
        });
      }
      let raw: unknown;
      try {
        raw = await tool.handler(parsed.data, { user: call.user, sessionId: call.sessionId, runId: call.runId, ...ctx });
      } catch (e) {
        const message = (e instanceof Error ? e.message : String(e)) || `Site tool "${tool.name}" failed.`;
        throw new UncageError('tool_failed', { message: message.slice(0, MAX_ERROR_MESSAGE) });
      }
      return normalizeToolResult(raw);
    },
  };
}
