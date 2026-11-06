import { z } from 'zod';
import { ApprovalCategorySchema, ApprovalRequestSchema, RunSchema, RunStateSchema, SessionSchema } from './domain.js';
import { ErrorBodySchema } from './errors.js';

export const ToolInfoSchema = z.object({
  toolId: z.string(),
  name: z.string(),
  title: z.string(),
  category: ApprovalCategorySchema,
  input: z.unknown().optional(),
});
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

export const EventPayloadSchemas = {
  'session.created': z.object({ session: SessionSchema }),
  'session.updated': z.object({ session: SessionSchema }),
  'run.started': z.object({ run: RunSchema }),
  'run.updated': z.object({ runId: z.string(), state: RunStateSchema }),
  'run.completed': z.object({ runId: z.string(), durationMs: z.number() }),
  'run.failed': z.object({ runId: z.string(), error: ErrorBodySchema }),
  'run.cancelled': z.object({ runId: z.string() }),
  'run.interrupted': z.object({ runId: z.string(), reason: z.string() }),
  'message.started': z.object({ messageId: z.string(), role: z.literal('assistant') }),
  'message.delta': z.object({ messageId: z.string(), chunkIndex: z.number().int(), text: z.string() }),
  'message.completed': z.object({ messageId: z.string(), text: z.string() }),
  'tool.started': ToolInfoSchema,
  'tool.updated': z.object({ toolId: z.string(), output: z.string().optional() }),
  'tool.completed': z.object({
    toolId: z.string(),
    output: z.string().optional(),
    durationMs: z.number().optional(),
  }),
  'tool.failed': z.object({
    toolId: z.string(),
    error: z.string(),
    declined: z.boolean().optional(),
  }),
  'approval.requested': z.object({ approval: ApprovalRequestSchema }),
  'approval.updated': z.object({ approval: ApprovalRequestSchema }),
  'approval.resolved': z.object({ approval: ApprovalRequestSchema }),
  'system.warning': z.object({ code: z.string(), message: z.string() }),
} as const;

export type UncageEventMap = {
  [K in keyof typeof EventPayloadSchemas]: z.infer<(typeof EventPayloadSchemas)[K]>;
};
export type EventType = keyof UncageEventMap;

export interface EventEnvelope<K extends EventType = EventType> {
  eventId: string;
  sequence: number;
  sessionId: string;
  runId?: string;
  type: K;
  occurredAt: string;
  schemaVersion: '1.0';
  payload: UncageEventMap[K];
  extensions?: Record<string, unknown>;
}
export type UncageEvent = { [K in EventType]: EventEnvelope<K> }[EventType];

const envelopeShape = {
  eventId: z.string(),
  sequence: z.number().int().nonnegative(),
  sessionId: z.string(),
  runId: z.string().optional(),
  occurredAt: z.string(),
  schemaVersion: z.literal('1.0'),
  extensions: z.record(z.string(), z.unknown()).optional(),
};

const envelopeSchemaFor = <K extends EventType>(type: K) =>
  z.object({
    ...envelopeShape,
    type: z.literal(type),
    payload: EventPayloadSchemas[type],
  });

/** Per-type envelope schemas, e.g. `EventEnvelopeSchemas['message.delta']`. */
export const EventEnvelopeSchemas = Object.fromEntries(
  (Object.keys(EventPayloadSchemas) as EventType[]).map((t) => [t, envelopeSchemaFor(t)]),
) as { [K in EventType]: ReturnType<typeof envelopeSchemaFor<K>> };

export const UncageEventSchema = z.discriminatedUnion(
  'type',
  Object.values(EventEnvelopeSchemas) as unknown as [
    (typeof EventEnvelopeSchemas)[EventType],
    ...(typeof EventEnvelopeSchemas)[EventType][],
  ],
) as unknown as z.ZodType<UncageEvent>;
