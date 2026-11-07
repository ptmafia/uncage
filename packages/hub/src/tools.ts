import { UncageError } from '@uncage/core';
import { ToolSpecSchema, type ToolCallResult, type ToolSpec } from '@uncage/protocol';
import { z } from 'zod';
import type { HubUser } from './types.js';

export interface ToolContext {
  /** The session's owner (the hub re-checks ownership before calling the handler). */
  user: HubUser;
  sessionId: string;
  runId: string;
  /** Files from the session workspace on the machine (file channel). */
  files: {
    pull(path: string, o?: { maxBytes?: number }): AsyncIterable<{ path: string; data: Uint8Array }>;
    read(path: string): Promise<Uint8Array>;
  };
}

/** A website capability offered to the agent as an MCP tool. Executes on the hub, as the session's user. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SiteTool<I = any> {
  /** `^[a-z][a-z0-9_]{0,47}$`, no `__`. */
  name: string;
  description: string;
  input: z.ZodType<I>;
  /** When true the user confirms each call in the website UI first. */
  requiresConfirmation?: boolean;
  handler(args: I, ctx: ToolContext): Promise<ToolCallResult | string | object>;
}

/** Identity helper that keeps the handler's `args` typed from `input`. */
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

/** A tool call from a machine, already checked to belong to `user`'s session on that machine. */
export interface ToolCallRequest {
  user: HubUser;
  machineId: string;
  sessionId: string;
  runId: string;
  tool: string;
  args: unknown;
}

/** Seam for executing site tools on the hub node that holds the machine connection. */
export interface ToolExecutor {
  execute(call: ToolCallRequest): Promise<ToolCallResult>;
}

/** This build does not execute site tools yet: every call fails with `tool_failed`. */
export const notImplementedToolExecutor: ToolExecutor = {
  async execute() {
    throw new UncageError('tool_failed', {
      message: 'Site tool execution is not implemented in this hub build.',
      hint: 'Upgrade @uncage/hub to a version that executes site tools.',
    });
  },
};
