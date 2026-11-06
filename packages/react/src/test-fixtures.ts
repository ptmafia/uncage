import type { ConnectionState, SubscribeHandlers, UncageClient } from '@uncage/client';
import { UncageClientError } from '@uncage/client';
import type {
  ApprovalRequest,
  ErrorCode,
  EventType,
  Run,
  Session,
  SessionSnapshot,
  UncageEvent,
  UncageEventMap,
} from '@uncage/protocol';
import { ATTACHMENT_LIMITS } from '@uncage/protocol';
import { vi } from 'vitest';

export const T0 = '2026-11-06T00:00:00.000Z';

export const session = (over: Partial<Session> = {}): Session => ({
  id: 'ses_1',
  runtimeId: 'fake',
  workspace: '/w',
  title: 'Test',
  status: 'ready',
  readOnly: false,
  createdAt: T0,
  capabilities: {
    streaming: true,
    approval: { once: true, session: false, types: ['shell', 'file'] },
    nativeResume: true,
    diffEvents: false,
    mcp: false,
    skills: 'unknown',
    models: [],
    efforts: [],
    permissionModes: ['default'],
    attachments: { images: false, files: false, maxBytes: ATTACHMENT_LIMITS.maxBytes },
  },
  settings: { permissionMode: 'default' },
  ...over,
});

export const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_1',
  sessionId: 'ses_1',
  prompt: 'hello',
  state: 'queued',
  createdAt: T0,
  ...over,
});

export const approval = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'apr_1',
  sessionId: 'ses_1',
  runId: 'run_1',
  toolId: 'tool_1',
  runtimeId: 'fake',
  category: 'shell',
  title: 'Run ls',
  target: { command: 'ls' },
  allowedScopes: ['once'],
  availableDecisions: ['allow_once', 'deny'],
  state: 'pending',
  createdAt: T0,
  expiresAt: T0,
  version: 1,
  ...over,
});

export const snapshot = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  session: session(),
  runs: [],
  pendingApprovals: [],
  lastSequence: 0,
  ...over,
});

/** Builds events with auto-incrementing sequences. */
export function eventFactory(start = 1) {
  let seq = start;
  return <K extends EventType>(type: K, payload: UncageEventMap[K], runId = 'run_1'): UncageEvent =>
    ({
      eventId: `evt_${seq}`,
      sequence: seq++,
      sessionId: 'ses_1',
      runId,
      type,
      occurredAt: T0,
      schemaVersion: '1.0',
      payload,
    }) as UncageEvent;
}

export const clientError = (code: ErrorCode, status: number) =>
  new UncageClientError({ code, message: code, retryable: false }, status);

/** A controllable in-memory UncageClient. `emit` pushes events to the live subscription. */
export function fakeClient(snap: () => SessionSnapshot = () => snapshot()) {
  const subs: (SubscribeHandlers & { sessionId: string; closed: boolean })[] = [];
  let runCount = 0;
  const client = {
    health: vi.fn(async () => ({ ok: true as const, protocol: '1.0' as const })),
    runtimes: vi.fn(async () => []),
    createSession: vi.fn(async () => session()),
    listSessions: vi.fn(async () => [session()]),
    snapshot: vi.fn(async () => snap()),
    startRun: vi.fn(async (sessionId: string, b: { prompt: string }) =>
      run({ id: `run_${++runCount}`, sessionId, prompt: b.prompt }),
    ),
    cancelRun: vi.fn(async (id: string) => run({ id, state: 'cancelled' })),
    decide: vi.fn(async (id: string) => approval({ id, state: 'approved', decision: 'allow', version: 2 })),
    subscribe: vi.fn((sessionId: string, h: SubscribeHandlers) => {
      const sub = { ...h, sessionId, closed: false };
      subs.push(sub);
      return () => {
        sub.closed = true;
      };
    }),
  } satisfies UncageClient;
  const live = () => subs.filter((s) => !s.closed).at(-1);
  return {
    client,
    subs,
    emit: (e: UncageEvent) => live()?.onEvent(e),
    state: (s: ConnectionState) => live()?.onState?.(s),
    fail: (err: UncageClientError) => {
      const sub = live();
      if (!sub) return;
      sub.onState?.('offline');
      sub.closed = true;
      sub.onError?.(err);
    },
  };
}
