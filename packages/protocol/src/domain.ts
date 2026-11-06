import { z } from 'zod';
import { ErrorBodySchema } from './errors.js';

export const RunStateSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const ApprovalStateSchema = z.enum([
  'pending',
  'submitting',
  'approved',
  'denied',
  'expired',
  'cancelled',
  'failed',
  'reconciling',
]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const RuntimeStatusSchema = z.enum([
  'available',
  'not_installed',
  'auth_required',
  'incompatible',
  'error',
]);
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

export const ApprovalCategorySchema = z.enum(['shell', 'file', 'network', 'mcp', 'other']);
export type ApprovalCategory = z.infer<typeof ApprovalCategorySchema>;

export const RuntimeCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  approval: z.object({
    once: z.boolean(),
    session: z.boolean(),
    types: z.array(ApprovalCategorySchema),
  }),
  nativeResume: z.boolean(),
  diffEvents: z.boolean(),
  mcp: z.boolean(),
  skills: z.enum(['supported', 'partial', 'unknown']),
});
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

export const RuntimeInfoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  status: RuntimeStatusSchema,
  version: z.string().optional(),
  capabilities: RuntimeCapabilitiesSchema.optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
  installUrl: z.string().optional(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  runtimeId: z.string(),
  workspace: z.string(),
  title: z.string(),
  status: z.enum(['ready', 'busy', 'unavailable', 'closed']),
  readOnly: z.boolean(),
  createdAt: z.string(),
  capabilities: RuntimeCapabilitiesSchema,
  activeRunId: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

export const RunSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  prompt: z.string(),
  state: RunStateSchema,
  createdAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  error: ErrorBodySchema.optional(),
});
export type Run = z.infer<typeof RunSchema>;

export const ApprovalTargetSchema = z.object({
  command: z.string().optional(),
  cwd: z.string().optional(),
  path: z.string().optional(),
  host: z.string().optional(),
});
export type ApprovalTarget = z.infer<typeof ApprovalTargetSchema>;

export const ApprovalAvailableDecisionSchema = z.enum(['allow_once', 'allow_session', 'deny']);

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  toolId: z.string().optional(),
  runtimeId: z.string(),
  category: ApprovalCategorySchema,
  title: z.string(),
  description: z.string().optional(),
  target: ApprovalTargetSchema,
  allowedScopes: z.array(z.enum(['once', 'session'])),
  // Runtime-reported; V0 UI only shows allow_once / deny.
  availableDecisions: z.array(ApprovalAvailableDecisionSchema),
  state: ApprovalStateSchema,
  decision: z.enum(['allow', 'deny']).optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
  version: z.number().int(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'session']),
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
