import type { Run, SessionSnapshot, UncageEvent } from '@uncage/protocol';
import type { ActiveRunRecord, ReplicaSnapshot, SessionPatch, SessionRecord } from './store/store.js';

export const emptySnapshot = (): ReplicaSnapshot => ({ runs: [], pendingApprovals: [], lastSequence: 0 });

const TERMINAL: Record<string, Run['state']> = {
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
  'run.interrupted': 'interrupted',
};

/** Applies one event to a replica snapshot (pure). Mirrors what core's snapshot would report. */
export function applyEvent(s: ReplicaSnapshot, e: UncageEvent): ReplicaSnapshot {
  const next: ReplicaSnapshot = { ...s, lastSequence: e.sequence };
  const patchRun = (runId: string, patch: Partial<Run>) => {
    next.runs = s.runs.map((r) => (r.id === runId ? { ...r, ...patch } : r));
  };
  switch (e.type) {
    case 'session.created':
    case 'session.updated':
      next.session = e.payload.session;
      break;
    case 'run.started': {
      const run = e.payload.run;
      next.runs = s.runs.some((r) => r.id === run.id) ? s.runs.map((r) => (r.id === run.id ? run : r)) : [...s.runs, run];
      break;
    }
    case 'run.updated':
      patchRun(e.payload.runId, { state: e.payload.state });
      break;
    case 'run.completed':
    case 'run.cancelled':
    case 'run.interrupted':
      patchRun(e.payload.runId, { state: TERMINAL[e.type]!, endedAt: e.occurredAt });
      break;
    case 'run.failed':
      patchRun(e.payload.runId, { state: 'failed', endedAt: e.occurredAt, error: e.payload.error });
      break;
    case 'approval.requested':
    case 'approval.updated':
    case 'approval.resolved': {
      const a = e.payload.approval;
      const rest = s.pendingApprovals.filter((p) => p.id !== a.id);
      next.pendingApprovals = a.state === 'pending' || a.state === 'submitting' ? [...rest, a] : rest;
      next.pendingApprovals.sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
      break;
    }
    default:
      break;
  }
  return next;
}

/** A replica snapshot as the API's `SessionSnapshot`, once the session itself is known. */
export function toSessionSnapshot(s: ReplicaSnapshot | undefined): SessionSnapshot | null {
  if (!s?.session) return null;
  return { session: s.session, runs: s.runs, pendingApprovals: s.pendingApprovals, lastSequence: s.lastSequence };
}

/** Index fields (title, active run) derived from a batch of events. */
export function indexPatch(rec: Pick<SessionRecord, 'title' | 'activeRun'>, events: UncageEvent[]): SessionPatch {
  let title = rec.title;
  let active: ActiveRunRecord | undefined = rec.activeRun;
  for (const e of events) {
    if (e.type === 'session.created' || e.type === 'session.updated') title = e.payload.session.title;
    else if (e.type === 'run.started') {
      const r = e.payload.run;
      active = { id: r.id, state: r.state, ...(r.startedAt ? { startedAt: r.startedAt } : {}) };
    } else if (e.type === 'run.updated' && active?.id === e.payload.runId) active = { ...active, state: e.payload.state };
    else if (e.type in TERMINAL && active?.id === (e.payload as { runId: string }).runId) active = undefined;
  }
  const patch: SessionPatch = {};
  if (title !== rec.title) patch.title = title;
  if (active !== rec.activeRun) patch.activeRun = active ?? null;
  return patch;
}
