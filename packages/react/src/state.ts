import type { ConnectionState, InstallInfo, UncageClientError } from '@uncage/client';
import type {
  ActiveRunInfo,
  ApprovalCategory,
  ApprovalRequest,
  Attachment,
  MachineInfo,
  Run,
  RuntimeInfo,
  Session,
  SessionSettings,
} from '@uncage/protocol';

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
  /**
   * The run that was active when the session's settings last changed (they apply from the next
   * run). Settings are "pending for the next run" while this run is still active.
   */
  pendingSettingsRunId?: string;
  /** Internal: the settings `pendingSettingsRunId` started with; reverting to them clears pending. */
  pendingSettingsBase?: SessionSettings;
  /**
   * The most recent `system.warning` (e.g. `setting_reset`: a stored setting the runtime no longer
   * offers was dropped when `runId` started). `runId` is the run it was raised for, else the latest
   * run when it arrived (absent if there was none), so UIs can hide it once a newer run starts.
   */
  lastWarning?: { code: string; message: string; runId?: string };
}

/** A file picked in the composer: validated client-side, then uploaded to the session. */
export interface DraftAttachment {
  localId: string;
  name: string;
  /** Bytes; `0` when unknown (a React Native file reference without `size`). */
  size: number;
  kind: 'image' | 'file' | null;
  /**
   * Image preview: an object URL (`blob:`, revoked on remove/clear/send/dispose) for a browser file,
   * the file's own `uri` for a React Native file reference.
   */
  previewUrl?: string;
  /** `uploading` also covers files queued until a draft's session exists. */
  status: 'uploading' | 'ready' | 'error';
  attachment?: Attachment;
  error?: UncageClientError;
}

export interface AttachmentRejection {
  name: string;
  reason: 'type' | 'size' | 'count';
}

export interface AttachmentsState {
  /** The session the items upload to; undefined while they are queued for a draft. */
  sessionId?: string;
  items: DraftAttachment[];
  /** Files refused by the most recent `addAttachments` call. */
  rejected: AttachmentRejection[];
}

/**
 * A new conversation that has no session yet. `open` is set by `openDraft` and cleared by
 * `selectSession`/`commitDraft`/`closeDraft`; with no active session the store is a draft too.
 */
export interface DraftState {
  open: boolean;
  runtimeId?: string;
  settings: SessionSettings;
  /**
   * A session `commitDraft` already created but could not finish (applying the draft settings
   * failed); a retry reuses it instead of creating another.
   */
  sessionId?: string;
}

/**
 * Connected mode: the user's computers on an Uncage hub. The mode is detected from the server:
 * a hub serves `GET /machines`; a local daemon answers 404 (`'local'`). Until a probe succeeds
 * (or after a probe failed for another reason) it is `'unknown'`, which UIs treat like local.
 */
export interface MachinesState {
  mode: 'unknown' | 'local' | 'connected';
  list: MachineInfo[];
  loading: boolean;
  /** The computer new sessions run on (kept while listed; else the first online one). */
  selectedId?: string;
  /** Install/setup commands (`loadInstallInfo`). */
  install?: InstallInfo;
  /** The last failed `loadMachines`/`loadInstallInfo` (cleared by the next success). */
  error?: UncageClientError;
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
  draft: DraftState;
  attachments: AttachmentsState;
  /** Active runs across all sessions on the server (polled while watched). */
  activeRuns: ActiveRunInfo[];
  machines: MachinesState;
}

/** Settings of a freshly created session (core's default). */
export const DEFAULT_SETTINGS: SessionSettings = { permissionMode: 'default' };

/** True when the composer targets a draft (no session yet) rather than the active session. */
export const isDraft = (s: StoreState): boolean => s.draft.open || s.activeSessionId === undefined;

export const ACTIVE_RUN_STATES: ReadonlySet<Run['state']> = new Set(['queued', 'running', 'waiting_approval']);

export const userMessageId = (runId: string) => `user_${runId}`;

/** The most recently created run of the session, if any. */
export function latestRun(runs: Record<string, Run>): Run | undefined {
  let latest: Run | undefined;
  for (const r of Object.values(runs)) if (!latest || r.createdAt >= latest.createdAt) latest = r;
  return latest;
}
