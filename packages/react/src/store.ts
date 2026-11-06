import { UncageClientError, type UncageClient } from '@uncage/client';
import type { CreateSessionBody, SessionSnapshot } from '@uncage/protocol';
import { applyEvent, initialSessionState, mergeSnapshot, upsertApproval, upsertRun } from './apply-event.js';
import { ACTIVE_RUN_STATES, latestRun, type SessionState, type StoreState } from './state.js';

export interface UncageStore {
  getState(): StoreState;
  subscribe(fn: () => void): () => void;
  actions: {
    loadRuntimes(): Promise<void>;
    loadSessions(): Promise<void>;
    createSession(b: CreateSessionBody): Promise<string>;
    selectSession(id: string): Promise<void>;
    sendPrompt(prompt: string): Promise<void>;
    cancelRun(): Promise<void>;
    decide(approvalId: string, d: 'allow' | 'deny', reason?: string): Promise<void>;
    dismissError(): void;
  };
}

const toClientError = (err: unknown): UncageClientError =>
  err instanceof UncageClientError
    ? err
    : new UncageClientError(
        { code: 'internal_error', message: err instanceof Error ? err.message : String(err), retryable: true },
        0,
      );

/**
 * Framework-agnostic normalized store over an UncageClient.
 *
 * Error policy: actions never reject, except `createSession` (it must return an id). Failures are
 * recorded in `lastError`, which UIs render and clear with `dismissError()`.
 *
 * History: a snapshot carries no message/tool history, so `selectSession` starts from the
 * snapshot's session/runs/pending approvals with an empty timeline and subscribes with
 * `after: 0`, rebuilding the timeline from the full replay. If the server can no longer replay
 * (`event_replay_unavailable`), the store merges a fresh snapshot, sets `replayIncomplete` and
 * resubscribes from `snapshot.lastSequence`.
 */
export function createUncageStore(client: UncageClient): UncageStore {
  let state: StoreState = {
    runtimes: [],
    runtimesLoading: false,
    sessions: [],
    sessionsLoading: false,
    pendingDecisions: {},
  };
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;
  /** Bumped on every session switch; async work started for an older selection is dropped. */
  let generation = 0;
  let sending = false;

  const set = (patch: Partial<StoreState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };
  const fail = (err: unknown) => set({ lastError: toClientError(err) });

  /** Updates the active session state if `gen` is still the current selection. */
  const updateActive = (gen: number, fn: (s: SessionState) => SessionState) => {
    if (gen !== generation || !state.active) return;
    const next = fn(state.active);
    if (next !== state.active) set({ active: next });
  };

  const rememberSession = (snap: SessionSnapshot) => {
    const i = state.sessions.findIndex((s) => s.id === snap.session.id);
    if (i === -1) return [snap.session, ...state.sessions];
    const sessions = [...state.sessions];
    sessions[i] = snap.session;
    return sessions;
  };

  const reloadSnapshot = async (gen: number, sessionId: string) => {
    const snap = await client.snapshot(sessionId);
    if (gen !== generation) return undefined;
    set({ sessions: rememberSession(snap) });
    updateActive(gen, (s) => mergeSnapshot(s, snap));
    return snap;
  };

  const listen = (gen: number, sessionId: string, after: number) => {
    unsubscribe = client.subscribe(sessionId, {
      after,
      onEvent: (e) => updateActive(gen, (s) => applyEvent(s, e)),
      onState: (connection) => updateActive(gen, (s) => (s.connection === connection ? s : { ...s, connection })),
      onError: (err) => {
        if (gen !== generation) return;
        if (err.code !== 'event_replay_unavailable') return fail(err);
        void (async () => {
          try {
            const snap = await reloadSnapshot(gen, sessionId);
            if (!snap) return;
            updateActive(gen, (s) => ({ ...s, replayIncomplete: true }));
            listen(gen, sessionId, snap.lastSequence);
          } catch (e) {
            if (gen === generation) fail(e);
          }
        })();
      },
    });
  };

  const actions: UncageStore['actions'] = {
    async loadRuntimes() {
      set({ runtimesLoading: true });
      try {
        set({ runtimes: await client.runtimes(), runtimesLoading: false });
      } catch (err) {
        set({ runtimesLoading: false, lastError: toClientError(err) });
      }
    },

    async loadSessions() {
      set({ sessionsLoading: true });
      try {
        set({ sessions: await client.listSessions(), sessionsLoading: false });
      } catch (err) {
        set({ sessionsLoading: false, lastError: toClientError(err) });
      }
    },

    async createSession(b) {
      try {
        const session = await client.createSession(b);
        set({ sessions: [session, ...state.sessions.filter((s) => s.id !== session.id)] });
        return session.id;
      } catch (err) {
        fail(err);
        throw err;
      }
    },

    async selectSession(id) {
      const gen = ++generation;
      unsubscribe?.();
      unsubscribe = undefined;
      sending = false;
      set({ activeSessionId: id, active: undefined, pendingDecisions: {} });
      try {
        const snap = await client.snapshot(id);
        if (gen !== generation) return;
        // Keep session, runs and pending approvals; rebuild the timeline by replaying from 0.
        const base = initialSessionState(snap);
        const active: SessionState = { ...base, lastSequence: 0, messages: {}, tools: {}, timeline: [], chunks: {} };
        set({ active, sessions: rememberSession(snap) });
        listen(gen, id, 0);
      } catch (err) {
        if (gen === generation) fail(err);
      }
    },

    async sendPrompt(prompt) {
      const gen = generation;
      const active = state.active;
      if (!active || sending) return;
      const current = latestRun(active.runs);
      if (current && ACTIVE_RUN_STATES.has(current.state)) return;
      sending = true;
      try {
        const run = await client.startRun(active.session.id, { prompt });
        // Visible immediately even if `run.started` has not arrived yet; upsertRun is idempotent.
        updateActive(gen, (s) => (s.runs[run.id] ? s : upsertRun(s, run)));
      } catch (err) {
        if (gen === generation) fail(err);
      } finally {
        if (gen === generation) sending = false;
      }
    },

    async cancelRun() {
      const gen = generation;
      const current = state.active && latestRun(state.active.runs);
      if (!current || !ACTIVE_RUN_STATES.has(current.state)) return;
      try {
        const run = await client.cancelRun(current.id);
        updateActive(gen, (s) => upsertRun(s, run));
      } catch (err) {
        if (gen === generation) fail(err);
      }
    },

    async decide(approvalId, d, reason) {
      const gen = generation;
      const sessionId = state.activeSessionId;
      if (state.pendingDecisions[approvalId] || !sessionId) return;
      set({ pendingDecisions: { ...state.pendingDecisions, [approvalId]: d } });
      try {
        const approval = await client.decide(approvalId, {
          decision: d,
          scope: 'once',
          ...(reason !== undefined ? { reason } : {}),
        });
        updateActive(gen, (s) => upsertApproval(s, approval));
      } catch (err) {
        const code = err instanceof UncageClientError ? err.code : undefined;
        if (code === 'approval_already_resolved' || code === 'approval_expired') {
          // Someone else (or the TTL) resolved it: converge on server state instead of erroring.
          if (code === 'approval_expired') {
            updateActive(gen, (s) => {
              const a = s.approvals[approvalId];
              return a ? { ...s, approvals: { ...s.approvals, [approvalId]: { ...a, state: 'expired' } } } : s;
            });
          }
          try {
            await reloadSnapshot(gen, sessionId);
          } catch (e) {
            if (gen === generation) fail(e);
          }
        } else if (gen === generation) {
          fail(err);
        }
      } finally {
        if (gen === generation) {
          const { [approvalId]: _done, ...rest } = state.pendingDecisions;
          void _done;
          set({ pendingDecisions: rest });
        }
      }
    },

    dismissError() {
      if (state.lastError) set({ lastError: undefined });
    },
  };

  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    actions,
  };
}
