import { z } from 'zod';
import { ApprovalRequestSchema, RunSchema, SessionSchema } from './domain.js';

export const CreateSessionBodySchema = z.object({
  runtime: z.string(),
  workspace: z.string().optional(),
  title: z.string().optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

export const StartRunBodySchema = z.object({ prompt: z.string() });
export type StartRunBody = z.infer<typeof StartRunBodySchema>;

export const SessionSnapshotSchema = z.object({
  session: SessionSchema,
  runs: z.array(RunSchema),
  pendingApprovals: z.array(ApprovalRequestSchema),
  lastSequence: z.number().int().nonnegative(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  protocol: z.literal('1.0'),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
