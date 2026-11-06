import type { ApprovalRequest, Run, Session, SessionSettings, SessionSnapshot, UncageEvent } from '@uncage/protocol';
import {
  ACTIVE_RUN_STATES,
  latestRun,
  userMessageId,
  type MessageView,
  type SessionState,
  type TimelineItem,
  type ToolView,
} from './state.js';

const isTerminal = (state: Run['state']) => !ACTIVE_RUN_STATES.has(state);

export const sameSettings = (a: SessionSettings, b: SessionSettings): boolean =>
  a.model === b.model && a.effort === b.effort && a.permissionMode === b.permissionMode;

export function emptySessionState(session: Session): SessionState {
  return {
    session,
    lastSequence: 0,
    connection: 'connecting',
    replayIncomplete: false,
    runs: {},
    messages: {},
    tools: {},
    approvals: {},
    timeline: [],
    chunks: {},
  };
}

/**
 * State derived from a snapshot alone: session, runs (each with its user prompt in the
 * timeline) and pending approvals, with `lastSequence = snap.lastSequence`. A snapshot carries no
 * assistant messages or tools; to restore those, start from an empty history and replay from 0.
 */
export function initialSessionState(snap: SessionSnapshot): SessionState {
  return mergeSnapshot(emptySessionState(snap.session), snap);
}

/**
 * Overlays a (newer) snapshot onto existing state: the snapshot is authoritative for session and
 * run states; approvals are replaced only by a newer version; missing user prompts and
 * approvals are appended to the timeline. Existing messages and tools are kept.
 */
export function mergeSnapshot(s: SessionState, snap: SessionSnapshot): SessionState {
  let next: SessionState = { ...s, session: snap.session, lastSequence: Math.max(s.lastSequence, snap.lastSequence) };
  const runs = [...snap.runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const r of runs) {
    next = upsertRun(next, r, true);
    if (isTerminal(r.state)) next = finishRun(next, r.id, r.state);
  }
  for (const a of snap.pendingApprovals) next = upsertApproval(next, a);
  return next;
}

/** Merges only a snapshot's pending approvals (version-guarded); runs and sequence untouched. */
export function mergeSnapshotApprovals(s: SessionState, snap: SessionSnapshot): SessionState {
  return snap.pendingApprovals.reduce(upsertApproval, s);
}

/**
 * Applies a Run returned by the API (e.g. from cancel). Never regresses a terminal run; if the
 * resulting run is terminal, its streaming messages and running tools are settled.
 */
export function settleRun(s: SessionState, run: Run): SessionState {
  const next = upsertRun(s, run);
  const merged = next.runs[run.id]!;
  return isTerminal(merged.state) ? finishRun(next, run.id, merged.state, merged.endedAt) : next;
}

/**
 * Adds or updates a run and its user prompt message (`user_<runId>`). Unless `authoritative`,
 * a terminal run is never moved back to a non-terminal state (replayed or late events).
 */
export function upsertRun(s: SessionState, run: Run, authoritative = false): SessionState {
  const prev = s.runs[run.id];
  const merged = prev && !authoritative && isTerminal(prev.state) && !isTerminal(run.state) ? { ...run, ...prev } : run;
  let next: SessionState = { ...s, runs: { ...s.runs, [run.id]: merged } };
  const id = userMessageId(run.id);
  if (!next.messages[id]) {
    const message: MessageView = {
      id,
      runId: run.id,
      role: 'user',
      text: run.prompt,
      streaming: false,
      startedAt: run.createdAt,
    };
    next = { ...next, messages: { ...next.messages, [id]: message }, timeline: [...next.timeline, { kind: 'message', id }] };
  }
  return next;
}

/** Replaces an approval only with a newer version (server bumps it on every transition); adds its timeline item once. */
export function upsertApproval(s: SessionState, a: ApprovalRequest): SessionState {
  const prev = s.approvals[a.id];
  const approvals = prev && prev.version >= a.version ? s.approvals : { ...s.approvals, [a.id]: a };
  const listed = s.timeline.some((i) => i.kind === 'approval' && i.id === a.id);
  const timeline: TimelineItem[] = listed ? s.timeline : [...s.timeline, { kind: 'approval', id: a.id }];
  return approvals === s.approvals && timeline === s.timeline ? s : { ...s, approvals, timeline };
}

function patchRun(s: SessionState, runId: string, patch: Partial<Run>): SessionState {
  const prev = s.runs[runId];
  if (!prev) return s;
  if (isTerminal(prev.state) && patch.state !== undefined) return s;
  return { ...s, runs: { ...s.runs, [runId]: { ...prev, ...patch } } };
}

/** Stops any still-streaming message and still-running tool of a run that has ended. */
function finishRun(s: SessionState, runId: string, state: Run['state'], at?: string): SessionState {
  let messages = s.messages;
  for (const m of Object.values(s.messages)) {
    if (m.runId === runId && m.streaming) {
      messages = { ...messages, [m.id]: { ...m, streaming: false, ...(at ? { endedAt: at } : {}) } };
    }
  }
  let tools = s.tools;
  for (const t of Object.values(s.tools)) {
    if (t.runId === runId && t.status === 'running') {
      tools = { ...tools, [t.id]: { ...t, status: state === 'completed' ? 'completed' : 'failed' } };
    }
  }
  return messages === s.messages && tools === s.tools ? s : { ...s, messages, tools };
}

function endRun(s: SessionState, runId: string, state: Run['state'], at: string, extra: Partial<Run> = {}) {
  return finishRun(patchRun(s, runId, { state, endedAt: at, ...extra }), runId, state, at);
}

function ensureMessage(s: SessionState, messageId: string, runId: string, at: string): SessionState {
  if (s.messages[messageId]) return s;
  const message: MessageView = { id: messageId, runId, role: 'assistant', text: '', streaming: true, startedAt: at };
  return {
    ...s,
    messages: { ...s.messages, [messageId]: message },
    timeline: [...s.timeline, { kind: 'message', id: messageId }],
    chunks: { ...s.chunks, [messageId]: { next: 0, buffered: {} } },
  };
}

function setMessage(s: SessionState, id: string, patch: Partial<MessageView>): SessionState {
  return { ...s, messages: { ...s.messages, [id]: { ...s.messages[id]!, ...patch } } };
}

function setTool(s: SessionState, id: string, patch: Partial<ToolView>): SessionState {
  const prev = s.tools[id];
  return prev ? { ...s, tools: { ...s.tools, [id]: { ...prev, ...patch } } } : s;
}

/** Appends a tool to the open tools group of its run, or opens a new group. */
function addToolToTimeline(timeline: TimelineItem[], runId: string, toolId: string): TimelineItem[] {
  const last = timeline.at(-1);
  if (last?.kind === 'tools' && last.runId === runId) {
    if (last.toolIds.includes(toolId)) return timeline;
    return [...timeline.slice(0, -1), { ...last, toolIds: [...last.toolIds, toolId] }];
  }
  return [...timeline, { kind: 'tools', runId, toolIds: [toolId] }];
}

/**
 * Pure reducer. Returns `s` unchanged for an event whose sequence is not newer than
 * `s.lastSequence`, which makes replays and reconnect overlaps idempotent.
 */
export function applyEvent(s: SessionState, e: UncageEvent): SessionState {
  if (e.sequence <= s.lastSequence) return s;
  return { ...reduce(s, e), lastSequence: e.sequence };
}

function reduce(s: SessionState, e: UncageEvent): SessionState {
  const at = e.occurredAt;
  const runId = e.runId ?? '';
  switch (e.type) {
    case 'session.created':
      return { ...s, session: e.payload.session };
    case 'session.updated': {
      // A settings PATCH (no runId) during an active run applies from the next run. A run-scoped
      // update (e.g. `setting_reset` at run start) already applies to that run.
      const current = latestRun(s.runs);
      const pending =
        e.runId === undefined &&
        current !== undefined &&
        !isTerminal(current.state) &&
        !sameSettings(s.session.settings, e.payload.session.settings);
      return { ...s, session: e.payload.session, ...(pending ? { pendingSettingsRunId: current.id } : {}) };
    }

    case 'run.started':
      return upsertRun(s, e.payload.run);
    case 'run.updated':
      if (isTerminal(e.payload.state)) return endRun(s, e.payload.runId, e.payload.state, at);
      return patchRun(s, e.payload.runId, {
        state: e.payload.state,
        ...(e.payload.state === 'running' && !s.runs[e.payload.runId]?.startedAt ? { startedAt: at } : {}),
      });
    case 'run.completed':
      return endRun(s, e.payload.runId, 'completed', at);
    case 'run.failed':
      return endRun(s, e.payload.runId, 'failed', at, { error: e.payload.error });
    case 'run.cancelled':
      return endRun(s, e.payload.runId, 'cancelled', at);
    case 'run.interrupted':
      return endRun(s, e.payload.runId, 'interrupted', at);

    case 'message.started':
      return ensureMessage(s, e.payload.messageId, runId, at);
    case 'message.delta': {
      const { messageId, chunkIndex, text } = e.payload;
      const next = ensureMessage(s, messageId, runId, at);
      const cursor = next.chunks[messageId] ?? { next: 0, buffered: {} };
      if (chunkIndex < cursor.next || !next.messages[messageId]!.streaming) return next;
      const buffered = { ...cursor.buffered, [chunkIndex]: text };
      let index = cursor.next;
      let appended = '';
      while (buffered[index] !== undefined) {
        appended += buffered[index];
        delete buffered[index];
        index++;
      }
      const withCursor = { ...next, chunks: { ...next.chunks, [messageId]: { next: index, buffered } } };
      return appended ? setMessage(withCursor, messageId, { text: next.messages[messageId]!.text + appended }) : withCursor;
    }
    case 'message.completed': {
      const { messageId, text } = e.payload;
      const next = ensureMessage(s, messageId, runId, at);
      const { [messageId]: _done, ...chunks } = next.chunks;
      void _done;
      return { ...setMessage(next, messageId, { text, streaming: false, endedAt: at }), chunks };
    }

    case 'tool.started': {
      const { toolId, name, title, category } = e.payload;
      const tool: ToolView = { id: toolId, runId, name, title, category, status: 'running', startedAt: at };
      return {
        ...s,
        tools: { ...s.tools, [toolId]: { ...tool, ...(s.tools[toolId] ? { status: s.tools[toolId].status } : {}) } },
        timeline: addToolToTimeline(s.timeline, runId, toolId),
      };
    }
    case 'tool.updated': {
      const { toolId, output } = e.payload;
      if (output === undefined) return s;
      return setTool(s, toolId, { output: (s.tools[toolId]?.output ?? '') + output });
    }
    case 'tool.completed': {
      const { toolId, output, durationMs } = e.payload;
      return setTool(s, toolId, {
        status: 'completed',
        ...(output !== undefined ? { output } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
    case 'tool.failed':
      return setTool(s, e.payload.toolId, {
        status: e.payload.declined ? 'declined' : 'failed',
        error: e.payload.error,
      });

    case 'approval.requested':
    case 'approval.updated':
    case 'approval.resolved':
      return upsertApproval(s, e.payload.approval);

    case 'system.warning': {
      const { code, message } = e.payload;
      // A warning not raised for a run belongs to the run that was latest when it arrived.
      const id = e.runId ?? latestRun(s.runs)?.id;
      return { ...s, lastWarning: { code, message, ...(id !== undefined ? { runId: id } : {}) } };
    }
  }
}
