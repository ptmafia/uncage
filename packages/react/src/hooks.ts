import type { ConnectionState, CreateSessionRequest, InstallInfo, UncageClientError } from '@uncage/client';
import type {
  ActiveRunInfo,
  ApprovalRequest,
  MachineInfo,
  Run,
  RuntimeCapabilities,
  RuntimeInfo,
  Session,
  SessionSettings,
} from '@uncage/protocol';
import { useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { UncageStoreContext } from './provider.js';
import {
  ACTIVE_RUN_STATES,
  DEFAULT_SETTINGS,
  isDraft,
  latestRun,
  type AttachmentRejection,
  type DraftAttachment,
  type MachinesState,
  type MessageView,
  type StoreState,
  type TimelineItem,
  type ToolView,
} from './state.js';
import type { UncageStore } from './store.js';

const EMPTY_RECORD: Record<string, never> = {};
const EMPTY_TIMELINE: TimelineItem[] = [];

export function useUncageStore(): UncageStore {
  const store = useContext(UncageStoreContext);
  if (!store) throw new Error('Uncage hooks must be used inside <UncageProvider>.');
  return store;
}

/**
 * Subscribes to one slice of the store. The selector must return a value that is referentially
 * stable while the slice is unchanged (a stored field, not a freshly built object).
 */
export function useStoreSelector<T>(selector: (s: StoreState) => T): T {
  const store = useUncageStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

export function useRuntimes(): { runtimes: RuntimeInfo[]; loading: boolean } {
  const store = useUncageStore();
  const runtimes = useStoreSelector((s) => s.runtimes);
  const loading = useStoreSelector((s) => s.runtimesLoading);
  useEffect(() => {
    const s = store.getState();
    if (s.runtimes.length === 0 && !s.runtimesLoading) void store.actions.loadRuntimes();
  }, [store]);
  return useMemo(() => ({ runtimes, loading }), [runtimes, loading]);
}

export function useSessions(): {
  sessions: Session[];
  activeSessionId?: string;
  loading: boolean;
  select(id: string): Promise<void>;
  create(b: CreateSessionRequest): Promise<string>;
  reload(): Promise<void>;
} {
  const store = useUncageStore();
  const sessions = useStoreSelector((s) => s.sessions);
  const activeSessionId = useStoreSelector((s) => s.activeSessionId);
  const loading = useStoreSelector((s) => s.sessionsLoading);
  useEffect(() => {
    const s = store.getState();
    if (s.sessions.length === 0 && !s.sessionsLoading) void store.actions.loadSessions();
  }, [store]);
  return useMemo(
    () => ({
      sessions,
      ...(activeSessionId !== undefined ? { activeSessionId } : {}),
      loading,
      select: store.actions.selectSession,
      create: store.actions.createSession,
      reload: store.actions.loadSessions,
    }),
    [store, sessions, activeSessionId, loading],
  );
}

export function useConnection(): ConnectionState {
  return useStoreSelector((s) => s.active?.connection ?? 'offline');
}

export function useSession(): { session?: Session; connection: ConnectionState; replayIncomplete: boolean } {
  const session = useStoreSelector((s) => s.active?.session);
  const connection = useConnection();
  const replayIncomplete = useStoreSelector((s) => s.active?.replayIncomplete ?? false);
  return useMemo(
    () => ({ ...(session ? { session } : {}), connection, replayIncomplete }),
    [session, connection, replayIncomplete],
  );
}

export function useRun(): { run?: Run; isActive: boolean; send(prompt: string): Promise<boolean>; cancel(): Promise<void> } {
  const store = useUncageStore();
  const runs = useStoreSelector((s) => s.active?.runs);
  return useMemo(() => {
    const run = runs ? latestRun(runs) : undefined;
    return {
      ...(run ? { run } : {}),
      isActive: run !== undefined && ACTIVE_RUN_STATES.has(run.state),
      send: store.actions.sendPrompt,
      cancel: store.actions.cancelRun,
    };
  }, [store, runs]);
}

export function useMessages(): {
  timeline: TimelineItem[];
  messages: Record<string, MessageView>;
  tools: Record<string, ToolView>;
} {
  const timeline = useStoreSelector((s) => s.active?.timeline ?? EMPTY_TIMELINE);
  const messages = useStoreSelector((s) => s.active?.messages ?? EMPTY_RECORD);
  const tools = useStoreSelector((s) => s.active?.tools ?? EMPTY_RECORD);
  return useMemo(() => ({ timeline, messages, tools }), [timeline, messages, tools]);
}

export function useApprovals(): { pending: ApprovalRequest[]; all: ApprovalRequest[] } {
  const approvals = useStoreSelector((s) => s.active?.approvals ?? EMPTY_RECORD);
  return useMemo(() => {
    const all = Object.values(approvals);
    return { all, pending: all.filter((a) => a.state === 'pending') };
  }, [approvals]);
}

export function useApprovalActions(): {
  decide(id: string, d: 'allow' | 'deny', reason?: string): Promise<void>;
  pending: Record<string, 'allow' | 'deny'>;
} {
  const store = useUncageStore();
  const pending = useStoreSelector((s) => s.pendingDecisions);
  return useMemo(() => ({ decide: store.actions.decide, pending }), [store, pending]);
}

export function useRuntimeCapabilities(runtimeId?: string): RuntimeCapabilities | undefined {
  const runtimes = useStoreSelector((s) => s.runtimes);
  const session = useStoreSelector((s) => s.active?.session);
  const id = runtimeId ?? session?.runtimeId;
  if (id === undefined) return undefined;
  if (session && session.runtimeId === id) return session.capabilities;
  return runtimes.find((r) => r.id === id)?.capabilities;
}

export function useUncageError(): { error?: UncageClientError; dismiss(): void } {
  const store = useUncageStore();
  const error = useStoreSelector((s) => s.lastError);
  return useMemo(() => ({ ...(error ? { error } : {}), dismiss: store.actions.dismissError }), [store, error]);
}

/**
 * Settings the composer edits. With an open session: its settings and capabilities; an update
 * applies from the next run (`pendingForNextRun` while a run started before the change is still
 * active). In a draft (no session yet): the draft settings, validated against the draft runtime
 * and applied by `commitDraft` right after the session is created.
 */
export function useSessionSettings(): {
  settings: SessionSettings;
  capabilities?: RuntimeCapabilities;
  update(patch: Partial<SessionSettings>): Promise<boolean>;
  pendingForNextRun: boolean;
} {
  const store = useUncageStore();
  const draft = useStoreSelector(isDraft);
  const draftState = useStoreSelector((s) => s.draft);
  const runtimes = useStoreSelector((s) => s.runtimes);
  const session = useStoreSelector((s) => s.active?.session);
  const runs = useStoreSelector((s) => s.active?.runs);
  const pendingRunId = useStoreSelector((s) => s.active?.pendingSettingsRunId);
  return useMemo(() => {
    const update = store.actions.updateSettings;
    if (draft) {
      const capabilities = runtimes.find((r) => r.id === draftState.runtimeId)?.capabilities;
      return { settings: draftState.settings, ...(capabilities ? { capabilities } : {}), update, pendingForNextRun: false };
    }
    const pendingRun = pendingRunId !== undefined ? runs?.[pendingRunId] : undefined;
    return {
      settings: session?.settings ?? DEFAULT_SETTINGS,
      ...(session ? { capabilities: session.capabilities } : {}),
      update,
      pendingForNextRun: pendingRun !== undefined && ACTIVE_RUN_STATES.has(pendingRun.state),
    };
  }, [store, draft, draftState, runtimes, session, runs, pendingRunId]);
}

/**
 * Composer attachments. `add` validates client-side (type, runtime capability, size, at most
 * `ATTACHMENT_LIMITS.maxPerMessage`) and uploads to the open session; in a draft, files queue and
 * upload right after `commitDraft`. `ready` is false while an upload is in flight or has failed
 * (queued draft files count as ready: `sendPrompt` waits for their uploads).
 */
export function useAttachments(): {
  items: DraftAttachment[];
  add(files: File[]): void;
  remove(localId: string): void;
  clear(): void;
  ready: boolean;
  rejected: AttachmentRejection[];
} {
  const store = useUncageStore();
  const attachments = useStoreSelector((s) => s.attachments);
  return useMemo(() => {
    const queued = attachments.sessionId === undefined;
    return {
      items: attachments.items,
      rejected: attachments.rejected,
      ready: attachments.items.every((i) => i.status === 'ready' || (queued && i.status === 'uploading')),
      add: store.actions.addAttachments,
      remove: store.actions.removeAttachment,
      clear: store.actions.clearAttachments,
    };
  }, [store, attachments]);
}

/**
 * Active runs across all sessions on the server. Polls every 3 s while the document is visible and
 * refreshes on local run events, for as long as a component uses the hook.
 */
export function useRunningSessions(): { runs: ActiveRunInfo[]; count: number } {
  const store = useUncageStore();
  const runs = useStoreSelector((s) => s.activeRuns);
  useEffect(() => store.actions.watchActiveRuns(), [store]);
  return useMemo(() => ({ runs, count: runs.length }), [runs]);
}

/**
 * Connected mode: the signed-in user's computers on an Uncage hub. The first use probes the server
 * (`GET /machines`): a hub answers with the list (`connected`), a local daemon with 404 (`mode:
 * 'local'`; everything else stays as in Local Mode). `selected` is the computer new sessions run
 * on; `current` is the one the open session runs on (`session.machineId`, set by the hub), else
 * `selected`. `watch` polls while mounted and the page is visible (`true` = every 3 s, or a number
 * of ms).
 */
export function useMachines(opts: { watch?: boolean | number } = {}): {
  mode: MachinesState['mode'];
  connected: boolean;
  machines: MachineInfo[];
  selected?: MachineInfo;
  /** The open session's computer (`session.machineId`), else `selected`; absent if not listed. */
  current?: MachineInfo;
  /** Id of `current`, also when that computer is no longer listed (e.g. disconnected). */
  currentId?: string;
  loading: boolean;
  error?: UncageClientError;
  install?: InstallInfo;
  select(id: string): void;
  refresh(): Promise<void>;
  revoke(id: string): Promise<boolean>;
  loadInstallInfo(): Promise<boolean>;
} {
  const store = useUncageStore();
  const m = useStoreSelector((s) => s.machines);
  const draft = useStoreSelector(isDraft);
  const activeSessionId = useStoreSelector((s) => s.activeSessionId);
  const activeSession = useStoreSelector((s) => s.active?.session);
  const sessions = useStoreSelector((s) => s.sessions);
  const watch = opts.watch === true ? 3000 : typeof opts.watch === 'number' ? opts.watch : undefined;
  useEffect(() => {
    const s = store.getState().machines;
    if (s.mode === 'unknown' && !s.loading) void store.actions.loadMachines();
  }, [store]);
  useEffect(() => (watch !== undefined ? store.actions.watchMachines(watch) : undefined), [store, watch]);
  return useMemo(() => {
    const selected = m.list.find((x) => x.id === m.selectedId);
    // The hub stamps every session with its machine; it survives reloads.
    const sessionMachine =
      draft || activeSessionId === undefined
        ? undefined
        : (activeSession?.id === activeSessionId ? activeSession.machineId : undefined) ??
          sessions.find((s) => s.id === activeSessionId)?.machineId;
    const currentId = sessionMachine ?? selected?.id;
    const current = currentId !== undefined ? m.list.find((x) => x.id === currentId) : undefined;
    return {
      mode: m.mode,
      connected: m.mode === 'connected',
      machines: m.list,
      ...(selected ? { selected } : {}),
      ...(current ? { current } : {}),
      ...(currentId !== undefined ? { currentId } : {}),
      loading: m.loading,
      ...(m.error ? { error: m.error } : {}),
      ...(m.install ? { install: m.install } : {}),
      select: store.actions.selectMachine,
      refresh: store.actions.loadMachines,
      revoke: store.actions.revokeMachine,
      loadInstallInfo: store.actions.loadInstallInfo,
    };
  }, [store, m, draft, activeSessionId, activeSession, sessions]);
}

/** The URL of an attachment's content, for `<img src>` or links. */
export function useAttachmentUrl(attachmentId: string): string {
  const store = useUncageStore();
  return useMemo(() => store.attachmentUrl(attachmentId), [store, attachmentId]);
}

/** Where the open session is remembered across reloads (see `usePersistSession`). */
export type PersistSessionMode = 'url' | 'localStorage' | false;

/** The `?session=` query parameter (`'url'`) and the storage key (`'localStorage'`). */
export const PERSIST_SESSION_PARAM = 'session';
export const PERSIST_SESSION_STORAGE_KEY = 'uncage:session';

function readPersisted(mode: PersistSessionMode): string | undefined {
  if (mode === false || typeof window === 'undefined') return undefined;
  try {
    const id =
      mode === 'url'
        ? new URLSearchParams(window.location.search).get(PERSIST_SESSION_PARAM)
        : window.localStorage.getItem(PERSIST_SESSION_STORAGE_KEY);
    return id || undefined;
  } catch {
    return undefined; // storage disabled (privacy mode, sandboxed iframe)
  }
}

function writePersisted(mode: PersistSessionMode, id: string | undefined): void {
  if (mode === false || typeof window === 'undefined') return;
  try {
    if (mode === 'url') {
      const url = new URL(window.location.href);
      if ((url.searchParams.get(PERSIST_SESSION_PARAM) ?? undefined) === id) return;
      if (id === undefined) url.searchParams.delete(PERSIST_SESSION_PARAM);
      else url.searchParams.set(PERSIST_SESSION_PARAM, id);
      // replaceState keeps the router's state object (Next.js stores its tree there).
      window.history.replaceState(window.history.state, '', url);
    } else if (id === undefined) window.localStorage.removeItem(PERSIST_SESSION_STORAGE_KEY);
    else window.localStorage.setItem(PERSIST_SESSION_STORAGE_KEY, id);
  } catch {
    // storage disabled: nothing to remember
  }
}

/**
 * Remembers the open session so a reload lands on the same conversation: on mount it reopens the
 * remembered session (`?session=<id>` with `'url'`, a `localStorage` entry with `'localStorage'`),
 * then mirrors the open session there (`history.replaceState`, no new history entries) and clears
 * it when a new draft is opened. A remembered session that cannot be opened falls back to a new
 * draft (the error is shown unless the session simply no longer exists). `<AgentChat>` calls this (default `'url'`); headless UIs call it once near the root.
 */
export function usePersistSession(mode: PersistSessionMode = 'url'): void {
  const store = useUncageStore();
  const activeSessionId = useStoreSelector((s) => s.activeSessionId);
  const draftOpen = useStoreSelector((s) => s.draft.open);

  useEffect(() => {
    const id = readPersisted(mode);
    if (id === undefined || store.getState().activeSessionId !== undefined) return;
    void store.actions.selectSession(id).then(() => {
      const s = store.getState();
      // Still this selection and it did not open: the restore failed (selectSession records why).
      if (s.activeSessionId !== id || s.active !== undefined || s.lastError === undefined) return;
      // Forget it and start fresh. A deleted session (or one from another server) is not worth an
      // error; anything else (daemon down, …) stays visible in lastError.
      if (s.lastError.code === 'not_found') store.actions.dismissError();
      writePersisted(mode, undefined);
      store.actions.openDraft();
    });
  }, [store, mode]);

  useEffect(() => {
    // Before anything is open (first render, restore in flight) there is nothing to write.
    if (draftOpen) writePersisted(mode, undefined);
    else if (activeSessionId !== undefined) writePersisted(mode, activeSessionId);
  }, [mode, draftOpen, activeSessionId]);
}
