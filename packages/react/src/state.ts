import type { ConnectionState, UncageClientError } from '@uncage/client';
import type { ApprovalCategory, ApprovalRequest, Run, RuntimeInfo, Session } from '@uncage/protocol';

export interface MessageView {
  id: string;
  runId: string;
  role: 'user' | 'assistant';
  text: string;
  streaming: boolean;
  startedAt: string;
  endedAt?: string;
}

export interface ToolView {
  id: string;
  runId: string;
  name: string;
  title: string;
  category: ApprovalCategory;
  status: 'running' | 'completed' | 'failed' | 'declined';
  output?: string;
  /** Error text from `tool.failed`. */
  error?: string;
  startedAt: string;
  durationMs?: number;
}

export type TimelineItem =
  | { kind: 'message'; id: string }
  | { kind: 'tools'; runId: string; toolIds: string[] }
  | { kind: 'approval'; id: string };

/** Reassembly state for one streaming message: next expected chunk and out-of-order chunks. */
export interface ChunkCursor {
  next: number;
  buffered: Record<number, string>;
}

export interface SessionState {
  session: Session;
  lastSequence: number;
  connection: ConnectionState;
  replayIncomplete: boolean;
  runs: Record<string, Run>;
  messages: Record<string, MessageView>;
  tools: Record<string, ToolView>;
  approvals: Record<string, ApprovalRequest>;
  timeline: TimelineItem[];
  /** Internal: `message.delta` reassembly cursors, keyed by messageId. */
  chunks: Record<string, ChunkCursor>;
}

export interface StoreState {
  runtimes: RuntimeInfo[];
  runtimesLoading: boolean;
  sessions: Session[];
  sessionsLoading: boolean;
  activeSessionId?: string;
  active?: SessionState;
  pendingDecisions: Record<string, 'allow' | 'deny'>;
  lastError?: UncageClientError;
}

export const ACTIVE_RUN_STATES: ReadonlySet<Run['state']> = new Set(['queued', 'running', 'waiting_approval']);

export const userMessageId = (runId: string) => `user_${runId}`;

/** The most recently created run of the session, if any. */
export function latestRun(runs: Record<string, Run>): Run | undefined {
  let latest: Run | undefined;
  for (const r of Object.values(runs)) if (!latest || r.createdAt >= latest.createdAt) latest = r;
  return latest;
}
