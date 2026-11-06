import type { ConnectionState, UncageClientError } from '@uncage/client';
import type { ApprovalRequest, CreateSessionBody, Run, RuntimeCapabilities, RuntimeInfo, Session } from '@uncage/protocol';
import { useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { UncageStoreContext } from './provider.js';
import { ACTIVE_RUN_STATES, latestRun, type MessageView, type StoreState, type TimelineItem, type ToolView } from './state.js';
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
