import { z } from 'zod';
import {
  ApprovalAvailableDecisionSchema,
  ApprovalCategorySchema,
  ApprovalTargetSchema,
  AttachmentSchema,
  RuntimeStatusSchema,
  SessionSettingsSchema,
  type RuntimeCapabilities,
} from './domain.js';
import { SkillSpecSchema, type ToolCallResult, type ToolSpec } from './connected.js';
import { ErrorBodySchema } from './errors.js';
import type { RuntimeIcon } from './icon.js';
import { ToolInfoSchema } from './events.js';

export const RuntimeProbeSchema = z.object({
  status: RuntimeStatusSchema,
  version: z.string().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
  installUrl: z.string().optional(),
});
export type RuntimeProbe = z.infer<typeof RuntimeProbeSchema>;

export const ResolvedAttachmentSchema = AttachmentSchema.extend({ absPath: z.string() });
export type ResolvedAttachment = z.infer<typeof ResolvedAttachmentSchema>;

export const AdapterRunInputSchema = z.object({
  runId: z.string(),
  prompt: z.string(),
  cwd: z.string(),
  nativeSessionRef: z.string().optional(),
  settings: SessionSettingsSchema,
  attachments: z.array(ResolvedAttachmentSchema),
  /** Site skills for this run (connected mode). */
  skills: z.array(SkillSpecSchema).optional(),
});

/**
 * A site tool offered to the runtime for one run (connected mode). `call` round-trips to the site
 * (via the hub); adapters expose it under their own namespace and must never let it shadow a
 * built-in tool. Only passed to adapters whose capabilities advertise `siteTools`.
 */
export type RunTool = ToolSpec & { call(args: unknown): Promise<ToolCallResult> };

/** `tools` carries functions, so it has no wire form and is not part of the schema. */
export type AdapterRunInput = z.infer<typeof AdapterRunInputSchema> & { tools?: RunTool[] };

export const NativeApprovalInputSchema = z.object({
  toolId: z.string().optional(),
  category: ApprovalCategorySchema,
  title: z.string(),
  /** Defaults to ['allow_once', 'deny'] when omitted. */
  availableDecisions: z.array(ApprovalAvailableDecisionSchema).optional(),
  description: z.string().optional(),
  target: ApprovalTargetSchema,
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type NativeApprovalInput = z.infer<typeof NativeApprovalInputSchema>;

export const ApprovalOutcomeSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow') }),
  z.object({ decision: z.literal('deny'), reason: z.string().optional() }),
  z.object({ decision: z.literal('expired') }),
  z.object({ decision: z.literal('cancelled') }),
]);
export type ApprovalOutcome = z.infer<typeof ApprovalOutcomeSchema>;

export const RuntimeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('native.session'), ref: z.string() }),
  /**
   * The native session (`nativeSessionRef`) can no longer be resumed (e.g. Claude Code no longer has
   * the conversation). Terminal: core makes the session read-only and fails the run.
   */
  z.object({ type: z.literal('native.session_lost'), message: z.string().optional() }),
  z.object({ type: z.literal('message.started'), messageId: z.string() }),
  z.object({ type: z.literal('message.delta'), messageId: z.string(), text: z.string() }),
  z.object({ type: z.literal('message.completed'), messageId: z.string(), text: z.string() }),
  ToolInfoSchema.extend({ type: z.literal('tool.started') }),
  z.object({ type: z.literal('tool.updated'), toolId: z.string(), output: z.string().optional() }),
  z.object({
    type: z.literal('tool.completed'),
    toolId: z.string(),
    output: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    type: z.literal('tool.failed'),
    toolId: z.string(),
    error: z.string(),
    declined: z.boolean().optional(),
  }),
  z.object({ type: z.literal('warning'), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('run.completed') }),
  z.object({ type: z.literal('run.failed'), error: ErrorBodySchema }),
  z.object({ type: z.literal('run.interrupted'), reason: z.string() }),
]);
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

// Function-bearing contracts have no wire form, so they are plain TS interfaces.
export interface AdapterRunContext {
  signal: AbortSignal;
  requestApproval(input: NativeApprovalInput): Promise<ApprovalOutcome>;
}

export interface RuntimeAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Official icon, reported with the runtime info (data URIs only; see `RuntimeIconSchema`). */
  readonly icon?: RuntimeIcon;
  probe(): Promise<RuntimeProbe>;
  capabilities(): RuntimeCapabilities;
  /** Re-detect dynamic capabilities (e.g. model list). */
  refreshCapabilities?(): Promise<RuntimeCapabilities>;
  /** Abort via ctx.signal. */
  run(input: AdapterRunInput, ctx: AdapterRunContext): AsyncIterable<RuntimeEvent>;
  dispose?(): Promise<void>;
}
