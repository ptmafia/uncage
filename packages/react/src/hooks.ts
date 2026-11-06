import type { ConnectionState, UncageClientError } from '@uncage/client';
import type {
  ActiveRunInfo,
  ApprovalRequest,
  CreateSessionBody,
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
  create(b: CreateSessionBody): Promise<string>;
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

/** The URL of an attachment's content, for `<img src>` or links. */
export function useAttachmentUrl(attachmentId: string): string {
  const store = useUncageStore();
  return useMemo(() => store.attachmentUrl(attachmentId), [store, attachmentId]);
}
