import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, boolean } from 'drizzle-orm/pg-core';
import type { ApprovalRequest, ErrorBody, RuntimeCapabilities, SessionSettings } from '@uncage/protocol';

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  runtimeId: text('runtime_id').notNull(),
  workspace: text('workspace').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  readOnly: boolean('read_only').notNull(),
  createdAt: text('created_at').notNull(),
  capabilities: jsonb('capabilities').$type<RuntimeCapabilities>().notNull(),
  activeRunId: text('active_run_id'),
  nativeSessionRef: text('native_session_ref'),
  lastSequence: integer('last_sequence').notNull().default(0),
  prunedThrough: integer('pruned_through').notNull().default(0),
  settings: jsonb('settings').$type<SessionSettings>().notNull().default({ permissionMode: 'default' }),
});

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    prompt: text('prompt').notNull(),
    state: text('state').notNull(),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    error: jsonb('error').$type<ErrorBody>(),
  },
  (t) => [index('runs_session_idx').on(t.sessionId), index('runs_state_idx').on(t.state)],
);

export const events = pgTable(
  'events',
  {
    sessionId: text('session_id').notNull(),
    sequence: integer('sequence').notNull(),
    runId: text('run_id'),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    extensions: jsonb('extensions'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [unique('events_session_sequence_uq').on(t.sessionId, t.sequence), index('events_occurred_idx').on(t.occurredAt)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    runId: text('run_id').notNull(),
    toolId: text('tool_id'),
    runtimeId: text('runtime_id').notNull(),
    category: text('category').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    target: jsonb('target').$type<ApprovalRequest['target']>().notNull(),
    allowedScopes: jsonb('allowed_scopes').$type<ApprovalRequest['allowedScopes']>().notNull(),
    availableDecisions: jsonb('available_decisions').$type<ApprovalRequest['availableDecisions']>().notNull(),
    state: text('state').notNull(),
    decision: text('decision'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    version: integer('version').notNull(),
  },
  (t) => [index('approvals_session_idx').on(t.sessionId)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
);

export const attachments = pgTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    kind: text('kind').notNull(),
    sha256: text('sha256').notNull(),
    absPath: text('abs_path').notNull(),
    createdAt: text('created_at').notNull(),
    referencedByRun: text('referenced_by_run'),
  },
  (t) => [index('attachments_session_idx').on(t.sessionId), index('attachments_run_idx').on(t.referencedByRun)],
);
