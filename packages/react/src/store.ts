import { UncageClientError, uploadContentType, type UncageClient } from '@uncage/client';
import {
  ATTACHMENT_LIMITS,
  classifyAttachment,
  displayFileName,
  type ActiveRunInfo,
  type CreateSessionBody,
  type RuntimeCapabilities,
  type Session,
  type SessionSettings,
  type UncageEvent,
} from '@uncage/protocol';
import {
  applyEvent,
  initialSessionState,
  mergeSnapshot,
  mergeSnapshotApprovals,
  sameSettings,
  settleRun,
  upsertApproval,
  upsertRun,
  withSessionSettings,
} from './apply-event.js';
import {
  ACTIVE_RUN_STATES,
  DEFAULT_SETTINGS,
  isDraft,
  latestRun,
  type AttachmentRejection,
  type AttachmentsState,
  type DraftAttachment,
  type SessionState,
  type StoreState,
} from './state.js';

export interface UncageStore {
  getState(): StoreState;
  subscribe(fn: () => void): () => void;
  actions: {
    loadRuntimes(): Promise<void>;
    loadSessions(): Promise<void>;
    createSession(b: CreateSessionBody): Promise<string>;
    selectSession(id: string): Promise<void>;
    /**
     * Resolves `true` when a run was started; `false` when nothing was sent (busy, no session, an
     * attachment failed to upload, or the request failed). Waits for in-flight uploads, sends the
     * ready attachments' ids and clears them on success.
     */
    sendPrompt(prompt: string): Promise<boolean>;
    cancelRun(): Promise<void>;
    decide(approvalId: string, d: 'allow' | 'deny', reason?: string): Promise<void>;
    dismissError(): void;
    /**
     * Patches the settings the composer targets: the active session's (applies from its next run)
     * or, in a draft, the draft's (validated against the draft runtime's capabilities like the
     * server would, and applied by `commitDraft`). Resolves `false` and records `lastError` on failure.
     */
    updateSettings(patch: Partial<SessionSettings>): Promise<boolean>;
    /**
     * Enters (or updates) draft mode for a new session on `runtimeId`. Changing the runtime resets
     * the draft settings and re-validates queued files; attachments of an open session are dropped.
     */
    openDraft(runtimeId?: string): void;
    /** Leaves draft mode; with an open session, the draft's settings and queued files are discarded. */
    closeDraft(): void;
    /**
     * Creates a session from the draft: on the draft runtime (unless `b.runtime` is given), applies
     * the draft settings that differ from the new session's (before any run), starts uploading the
     * queued files to it and closes the draft. Then `selectSession(id)` and `sendPrompt` (which
     * waits for the uploads). Rejects, keeping the draft, if the session or its settings fail; a
     * retry reuses a session already created. If the draft is replaced or left meanwhile
     * (selectSession/openDraft/closeDraft), the created id is returned but the draft and the
     * current attachments are left untouched. `createSession` in a draft delegates here.
     */
    commitDraft(b?: Partial<CreateSessionBody>): Promise<string>;
    /**
     * Validates files client-side (same rules as the server, using the target runtime's
     * capabilities) and uploads accepted ones to the active session, or queues them in a draft.
     * Refused files are listed in `attachments.rejected`.
     */
    addAttachments(files: File[]): void;
    removeAttachment(localId: string): void;
    clearAttachments(): void;
    /** Fetches active runs across all sessions into `activeRuns` (errors are ignored). */
    refreshActiveRuns(): Promise<void>;
    /**
     * Polls active runs every 3 s while the document is visible (and on local run events) until
     * every returned stop function has been called.
     */
    watchActiveRuns(): () => void;
  };
  /** URL of an attachment's content (`client.attachmentUrl`). */
  attachmentUrl(attachmentId: string): string;
  /**
   * Closes the live subscription, stops active-run polling, aborts uploads (dropping attachments
   * and revoking their previews) and drops in-flight async results. Other state (including
   * `activeSessionId`) is kept, so `selectSession(activeSessionId)` resumes.
   */
  dispose(): void;
}

const toClientError = (err: unknown): UncageClientError =>
  err instanceof UncageClientError
    ? err
    : new UncageClientError(
        { code: 'internal_error', message: err instanceof Error ? err.message : String(err), retryable: true },
        0,
      );

const clientError = (
  code: UncageClientError['code'],
  message: string,
  details?: Record<string, unknown>,
): UncageClientError => new UncageClientError({ code, message, retryable: false, ...(details ? { details } : {}) }, 0);

/**
 * `details.reason` of the store's own error for a send blocked by an attachment whose upload
 * failed (code `invalid_request`, `details.name` = the file name), so UIs can localize it.
 */
export const UPLOAD_FAILED_REASON = 'attachment_upload_failed';

const ACTIVE_RUNS_POLL_MS = 3000;
const SETTING_KEYS = ['model', 'effort', 'permissionMode'] as const;
const EMPTY_ATTACHMENTS: AttachmentsState = { items: [], rejected: [] };

/**
 * Client-side mirror of the server's upload checks (core `AttachmentService.add`): extension and
 * canonical Content-Type (`classifyAttachment`), whether the runtime accepts the kind, and the size
 * limit (`ATTACHMENT_LIMITS.maxBytes`, the runtime's `maxBytes`, and its `maxImageBytes` for
 * images). Without capabilities only the global limits apply.
 */
export function checkAttachment(
  file: Blob & { name: string },
  caps?: RuntimeCapabilities['attachments'],
): { kind: 'image' | 'file' } | { reason: 'type' | 'size' } {
  const kind = classifyAttachment(displayFileName(file.name), uploadContentType(file));
  if (kind === null) return { reason: 'type' };
  if (caps && (kind === 'image' ? !caps.images : !caps.files)) return { reason: 'type' };
  const generalMax =
    caps && caps.maxBytes > 0 ? Math.min(caps.maxBytes, ATTACHMENT_LIMITS.maxBytes) : ATTACHMENT_LIMITS.maxBytes;
  const imageMax = caps?.maxImageBytes;
  const max = kind === 'image' && imageMax !== undefined && imageMax > 0 && imageMax < generalMax ? imageMax : generalMax;
  return file.size > max ? { reason: 'size' } : { kind };
}

/** Mirrors core `mergeSettings` (the policy is already reflected in `permissionModes`). */
function checkSettings(patch: Partial<SessionSettings>, caps: RuntimeCapabilities | undefined): UncageClientError | undefined {
  if (patch.model !== undefined && patch.model.trim() === '') return clientError('invalid_request', 'model must not be empty.');
  if (!caps) return undefined;
  const unsupported = (key: string, value: string) =>
    clientError('unsupported_capability', `The runtime does not support ${key} "${value}".`, { [key]: value });
  if (patch.model !== undefined && caps.models.length > 0 && !caps.models.some((m) => m.id === patch.model)) {
    return unsupported('model', patch.model);
  }
  if (patch.effort !== undefined && !caps.efforts.includes(patch.effort)) return unsupported('effort', patch.effort);
  if (patch.permissionMode !== undefined && !caps.permissionModes.includes(patch.permissionMode)) {
    return unsupported('permissionMode', patch.permissionMode);
  }
  return undefined;
}

const isRunLifecycle = (e: UncageEvent) =>
  e.type === 'run.started' ||
  e.type === 'run.completed' ||
  e.type === 'run.failed' ||
  e.type === 'run.cancelled' ||
  e.type === 'run.interrupted';

const sameActiveRuns = (a: ActiveRunInfo[], b: ActiveRunInfo[]) =>
  a.length === b.length &&
  a.every((r, i) => {
    const o = b[i]!;
    return r.runId === o.runId && r.sessionId === o.sessionId && r.sessionTitle === o.sessionTitle && r.state === o.state && r.startedAt === o.startedAt;
  });

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
    draft: { open: false, settings: DEFAULT_SETTINGS },
    attachments: EMPTY_ATTACHMENTS,
    activeRuns: [],
  };
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;
  /** Bumped on every session switch; async work started for an older selection is dropped. */
  let generation = 0;
  let sending = false;
  /** Bumped whenever the draft is replaced or left (openDraft/closeDraft/selectSession/dispose). */
  let draftEpoch = 0;

  const set = (patch: Partial<StoreState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };
  const fail = (err: unknown) => set({ lastError: toClientError(err) });

  // ---- attachments -------------------------------------------------------------------------
  /** Files not yet uploaded, and in-flight uploads, keyed by localId. */
  const files = new Map<string, File>();
  const uploads = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let localSeq = 0;

  const patchItem = (localId: string, patch: Partial<DraftAttachment>) => {
    const { items } = state.attachments;
    const i = items.findIndex((x) => x.localId === localId);
    if (i === -1) return;
    const next = [...items];
    next[i] = { ...items[i]!, ...patch };
    set({ attachments: { ...state.attachments, items: next } });
  };

  /** Aborts uploads and revokes previews of `items` (does not update state). */
  const release = (items: DraftAttachment[]) => {
    for (const item of items) {
      uploads.get(item.localId)?.controller.abort();
      uploads.delete(item.localId);
      files.delete(item.localId);
      if (item.previewUrl !== undefined) URL.revokeObjectURL(item.previewUrl);
    }
  };

  const dropAttachments = (next: AttachmentsState = EMPTY_ATTACHMENTS) => {
    release(state.attachments.items);
    if (state.attachments !== next) set({ attachments: next });
  };

  const startUpload = (localId: string, sessionId: string) => {
    const file = files.get(localId);
    if (!file || uploads.has(localId)) return;
    const controller = new AbortController();
    const done = client.uploadAttachment(sessionId, file, { signal: controller.signal }).then(
      (attachment) => {
        if (!controller.signal.aborted) patchItem(localId, { status: 'ready', attachment });
      },
      (err: unknown) => {
        if (!controller.signal.aborted) patchItem(localId, { status: 'error', error: toClientError(err) });
      },
    );
    uploads.set(localId, { controller, done });
    void done.finally(() => {
      if (uploads.get(localId)?.controller === controller) {
        uploads.delete(localId);
        files.delete(localId);
      }
    });
  };

  /** The runtime capabilities the composer validates against (draft runtime or active session). */
  const targetCapabilities = (): RuntimeCapabilities | undefined => {
    if (isDraft(state)) return state.runtimes.find((r) => r.id === state.draft.runtimeId)?.capabilities;
    const id = state.activeSessionId;
    return state.active?.session.capabilities ?? state.sessions.find((x) => x.id === id)?.capabilities;
  };

  // ---- active runs polling ------------------------------------------------------------------
  const watchers = new Set<object>();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;
  let refreshAgain = false;
  /** Bumped by dispose(): results of refreshes started before it are dropped. */
  let pollEpoch = 0;
  const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

  const refreshActiveRuns = async (): Promise<void> => {
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    const epoch = pollEpoch;
    refreshing = true;
    try {
      const runs = await client.listActiveRuns();
      if (epoch === pollEpoch && !sameActiveRuns(runs, state.activeRuns)) set({ activeRuns: runs });
    } catch {
      // Polling failures are transient noise; keep the last known list.
    } finally {
      if (epoch === pollEpoch) refreshing = false;
      if (epoch === pollEpoch && refreshAgain) {
        refreshAgain = false;
        void refreshActiveRuns();
      }
    }
  };
  const syncPolling = () => {
    const want = watchers.size > 0 && visible();
    if (want && pollTimer === undefined) {
      void refreshActiveRuns();
      pollTimer = setInterval(() => void refreshActiveRuns(), ACTIVE_RUNS_POLL_MS);
    } else if (!want && pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };
  const onVisibility = () => syncPolling();
  const stopPolling = () => {
    pollEpoch++;
    refreshing = false;
    refreshAgain = false;
    watchers.clear();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    syncPolling();
  };
  const runsChanged = () => {
    if (watchers.size > 0) void refreshActiveRuns();
  };

  /** Updates the active session state if `gen` is still the current selection. */
  const updateActive = (gen: number, fn: (s: SessionState) => SessionState) => {
    if (gen !== generation || !state.active) return;
    const next = fn(state.active);
    if (next !== state.active) set({ active: next });
  };

  /** `state.sessions` with `session` replaced (or prepended when new). */
  const rememberSession = (session: Session) => {
    const i = state.sessions.findIndex((s) => s.id === session.id);
    if (i === -1) return [session, ...state.sessions];
    const sessions = [...state.sessions];
    sessions[i] = session;
    return sessions;
  };

  /**
   * `authoritative` (only when the stream is dead): snapshot runs win and `lastSequence` jumps to
   * the snapshot's. Otherwise the live stream owns runs and sequences, and only pending approvals
   * are merged (version-guarded), so no event between local and snapshot sequence is dropped.
   */
  const reloadSnapshot = async (gen: number, sessionId: string, authoritative: boolean) => {
    const snap = await client.snapshot(sessionId);
    if (gen !== generation) return undefined;
    set({ sessions: rememberSession(snap.session) });
    updateActive(gen, (s) => (authoritative ? mergeSnapshot(s, snap) : mergeSnapshotApprovals(s, snap)));
    return snap;
  };

  const listen = (gen: number, sessionId: string, after: number) => {
    unsubscribe = client.subscribe(sessionId, {
      after,
      onEvent: (e) => {
        updateActive(gen, (s) => applyEvent(s, e));
        if (gen === generation && isRunLifecycle(e)) runsChanged();
      },
      onState: (connection) => updateActive(gen, (s) => (s.connection === connection ? s : { ...s, connection })),
      onError: (err) => {
        if (gen !== generation) return;
        if (err.code !== 'event_replay_unavailable') return fail(err);
        void (async () => {
          try {
            const snap = await reloadSnapshot(gen, sessionId, true);
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

  const createSession = async (b: CreateSessionBody): Promise<Session> => {
    try {
      const session = await client.createSession(b);
      set({ sessions: [session, ...state.sessions.filter((s) => s.id !== session.id)] });
      return session;
    } catch (err) {
      fail(err);
      throw err;
    }
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
      // In a draft, creating the session must carry the draft's settings and queued files along.
      if (isDraft(state)) return actions.commitDraft(b);
      return (await createSession(b)).id;
    },

    async selectSession(id) {
      const gen = ++generation;
      unsubscribe?.();
      unsubscribe = undefined;
      sending = false;
      draftEpoch++;
      if (state.attachments.sessionId !== id) dropAttachments();
      const draftUntouched = !state.draft.open && state.draft.settings === DEFAULT_SETTINGS;
      set({
        activeSessionId: id,
        active: undefined,
        pendingDecisions: {},
        ...(draftUntouched ? {} : { draft: { open: false, settings: DEFAULT_SETTINGS } }),
      });
      try {
        const snap = await client.snapshot(id);
        if (gen !== generation) return;
        // Keep session, runs and pending approvals; rebuild the timeline by replaying from 0.
        const base = initialSessionState(snap);
        const active: SessionState = { ...base, lastSequence: 0, messages: {}, tools: {}, timeline: [], chunks: {} };
        set({ active, sessions: rememberSession(snap.session) });
        listen(gen, id, 0);
      } catch (err) {
        if (gen === generation) fail(err);
      }
    },

    async sendPrompt(prompt) {
      const gen = generation;
      const active = state.active;
      if (!active || sending) return false;
      const current = latestRun(active.runs);
      if (current && ACTIVE_RUN_STATES.has(current.state)) return false;
      sending = true;
      const sessionId = active.session.id;
      try {
        // Attachments present at send time (and still present after their uploads settle).
        const bound = state.attachments.sessionId === sessionId ? state.attachments.items : [];
        if (bound.length > 0) await Promise.all(bound.map((i) => uploads.get(i.localId)?.done));
        if (gen !== generation) return false;
        const wanted = new Set(bound.map((i) => i.localId));
        const items =
          state.attachments.sessionId === sessionId ? state.attachments.items.filter((i) => wanted.has(i.localId)) : [];
        const failed = items.find((i) => i.status !== 'ready' || !i.attachment);
        if (failed) {
          const why = failed.error ? `: ${failed.error.message}` : '';
          fail(
            clientError('invalid_request', `Attachment "${failed.name}" could not be uploaded${why}. Remove it to send.`, {
              reason: UPLOAD_FAILED_REASON,
              name: failed.name,
            }),
          );
          return false;
        }
        const attachmentIds = items.map((i) => i.attachment!.id);
        const run = await client.startRun(sessionId, { prompt, ...(attachmentIds.length > 0 ? { attachmentIds } : {}) });
        // Visible immediately even if `run.started` has not arrived yet; upsertRun is idempotent.
        updateActive(gen, (s) => (s.runs[run.id] ? s : upsertRun(s, run)));
        if (items.length > 0 && state.attachments.sessionId === sessionId) {
          release(items);
          set({ attachments: { ...state.attachments, items: state.attachments.items.filter((i) => !wanted.has(i.localId)) } });
        }
        runsChanged();
        return true;
      } catch (err) {
        if (gen === generation) fail(err);
        return false;
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
        updateActive(gen, (s) => settleRun(s, run));
        runsChanged();
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
          // Someone else (or the TTL) resolved it: not an error. The live stream delivers the
          // final `approval.resolved`; until then a 409'd approval stays `pending` locally.
          if (code === 'approval_expired') {
            updateActive(gen, (s) => {
              const a = s.approvals[approvalId];
              return a ? { ...s, approvals: { ...s.approvals, [approvalId]: { ...a, state: 'expired' } } } : s;
            });
          }
          try {
            await reloadSnapshot(gen, sessionId, false);
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

    async updateSettings(patch) {
      if (isDraft(state)) {
        const invalid = checkSettings(patch, targetCapabilities());
        if (invalid) {
          fail(invalid);
          return false;
        }
        const settings = { ...state.draft.settings };
        for (const k of SETTING_KEYS) if (patch[k] !== undefined) Object.assign(settings, { [k]: patch[k] });
        set({ draft: { ...state.draft, settings } });
        return true;
      }
      const gen = generation;
      const sessionId = state.activeSessionId;
      if (sessionId === undefined) return false;
      try {
        const updated = await client.updateSettings(sessionId, patch);
        if (gen !== generation) return true;
        updateActive(gen, (s) =>
          sameSettings(s.session.settings, updated.settings) ? s : withSessionSettings(s, { ...s.session, settings: updated.settings }),
        );
        const known = state.sessions.find((s) => s.id === sessionId);
        if (known) set({ sessions: rememberSession({ ...known, settings: updated.settings }) });
        return true;
      } catch (err) {
        if (gen === generation) fail(err);
        return false;
      }
    },

    openDraft(runtimeId) {
      const prev = state.draft;
      const runtimeChanged = runtimeId !== prev.runtimeId;
      let attachments = state.attachments;
      if (attachments.sessionId !== undefined) {
        release(attachments.items);
        attachments = EMPTY_ATTACHMENTS;
      } else if (runtimeChanged && attachments.items.length > 0) {
        const caps = state.runtimes.find((r) => r.id === runtimeId)?.capabilities?.attachments;
        const keep: DraftAttachment[] = [];
        const rejected: AttachmentRejection[] = [];
        for (const item of attachments.items) {
          const file = files.get(item.localId);
          const check = file ? checkAttachment(file, caps) : { reason: 'type' as const };
          if ('reason' in check) {
            release([item]);
            rejected.push({ name: item.name, reason: check.reason });
          } else keep.push(item);
        }
        if (rejected.length > 0) attachments = { items: keep, rejected };
      }
      if (prev.open && !runtimeChanged && attachments === state.attachments) return;
      draftEpoch++;
      set({
        draft: {
          open: true,
          ...(runtimeId !== undefined ? { runtimeId } : {}),
          settings: runtimeChanged ? DEFAULT_SETTINGS : prev.settings,
          ...(!runtimeChanged && prev.sessionId !== undefined ? { sessionId: prev.sessionId } : {}),
        },
        attachments,
      });
    },

    closeDraft() {
      if (!state.draft.open) return;
      draftEpoch++;
      if (state.activeSessionId === undefined) {
        set({ draft: { ...state.draft, open: false } });
        return;
      }
      if (state.attachments.sessionId === undefined) dropAttachments();
      set({ draft: { open: false, settings: DEFAULT_SETTINGS } });
    },

    async commitDraft(b = {}) {
      const draft = state.draft;
      const epoch = draftEpoch;
      const runtime = b.runtime ?? draft.runtimeId;
      if (runtime === undefined) {
        const err = clientError('invalid_request', 'Choose a runtime for the new session.');
        fail(err);
        throw err;
      }
      // A previous attempt created the session but failed to apply the settings: reuse it.
      const reused =
        draft.sessionId !== undefined && (draft.runtimeId === undefined || draft.runtimeId === runtime)
          ? state.sessions.find((x) => x.id === draft.sessionId)
          : undefined;
      const session = reused ?? (await createSession({ ...b, runtime }));
      const current = () => epoch === draftEpoch;
      // Read after the await: the user may still have changed a draft setting meanwhile.
      const settings =
        current() && (draft.runtimeId === undefined || draft.runtimeId === runtime) ? state.draft.settings : DEFAULT_SETTINGS;
      const patch: Partial<SessionSettings> = {};
      for (const k of SETTING_KEYS) {
        if (settings[k] !== undefined && settings[k] !== session.settings[k]) Object.assign(patch, { [k]: settings[k] });
      }
      if (Object.keys(patch).length > 0) {
        try {
          const updated = await client.updateSettings(session.id, patch);
          set({ sessions: rememberSession(updated) });
        } catch (err) {
          fail(err);
          if (current()) set({ draft: { ...state.draft, sessionId: session.id } });
          throw err;
        }
      }
      // Only if the draft is still the one this call started from (no selectSession/openDraft/
      // closeDraft meanwhile) do its queued files move to the new session and the draft reset.
      if (current()) {
        const queued = state.attachments.sessionId === undefined ? state.attachments.items : [];
        set({
          draft: { open: false, settings: DEFAULT_SETTINGS },
          ...(state.attachments.sessionId === undefined
            ? { attachments: { ...state.attachments, sessionId: session.id } }
            : {}),
        });
        for (const item of queued) startUpload(item.localId, session.id);
      }
      return session.id;
    },

    addAttachments(picked) {
      const draft = isDraft(state);
      const sessionId = draft ? undefined : state.activeSessionId;
      if (state.attachments.sessionId !== sessionId) dropAttachments();
      const caps = targetCapabilities()?.attachments;
      const items = [...state.attachments.items];
      const rejected: AttachmentRejection[] = [];
      const added: string[] = [];
      for (const file of picked) {
        const check = checkAttachment(file, caps);
        if ('reason' in check) {
          rejected.push({ name: file.name, reason: check.reason });
          continue;
        }
        if (items.length >= ATTACHMENT_LIMITS.maxPerMessage) {
          rejected.push({ name: file.name, reason: 'count' });
          continue;
        }
        const localId = `local_${++localSeq}`;
        const canPreview = check.kind === 'image' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
        files.set(localId, file);
        items.push({
          localId,
          name: file.name,
          size: file.size,
          kind: check.kind,
          ...(canPreview ? { previewUrl: URL.createObjectURL(file) } : {}),
          status: 'uploading',
        });
        added.push(localId);
      }
      set({ attachments: { ...(sessionId !== undefined ? { sessionId } : {}), items, rejected } });
      if (sessionId !== undefined) for (const id of added) startUpload(id, sessionId);
    },

    removeAttachment(localId) {
      const item = state.attachments.items.find((i) => i.localId === localId);
      if (!item) return;
      release([item]);
      set({ attachments: { ...state.attachments, items: state.attachments.items.filter((i) => i !== item) } });
    },

    clearAttachments() {
      const { sessionId, items, rejected } = state.attachments;
      if (items.length === 0 && rejected.length === 0) return;
      dropAttachments(sessionId !== undefined ? { sessionId, items: [], rejected: [] } : EMPTY_ATTACHMENTS);
    },

    refreshActiveRuns,

    watchActiveRuns() {
      const token = {};
      watchers.add(token);
      if (watchers.size === 1 && typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibility);
      }
      syncPolling();
      return () => {
        if (!watchers.delete(token)) return;
        if (watchers.size === 0 && typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisibility);
        }
        syncPolling();
      };
    },
  };

  return {
    dispose() {
      generation++;
      unsubscribe?.();
      unsubscribe = undefined;
      sending = false;
      draftEpoch++;
      stopPolling();
      dropAttachments();
      if (Object.keys(state.pendingDecisions).length > 0) set({ pendingDecisions: {} });
    },
    attachmentUrl: (id) => client.attachmentUrl(id),
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    actions,
  };
}
