import type { ApprovalRequest, Attachment, Run, RunState, RuntimeInfo, Session, UncageEvent } from '@uncage/protocol';

/** A paired machine. Only the SHA-256 of its token is stored; the token itself is shown once. */
export interface MachineRecord {
  id: string;
  userId: string;
  /** Hex SHA-256 of the machine token. */
  tokenHash: string;
  name: string;
  os: string;
  agentVersion: string;
  runtimes: RuntimeInfo[];
  createdAt: string;
  lastSeenAt: string;
  /** Hex SHA-256 of the agent's persistent `machineKey`, when it sent one at pairing. */
  machineKeyHash?: string;
}

export type DeviceCodeStatus = 'pending' | 'approved' | 'denied' | 'consumed';

/** A device-login request. Both codes are stored hashed. */
export interface DeviceCodeRecord {
  /** Hex SHA-256 of the device code (the machine's polling secret). */
  deviceCodeHash: string;
  /** Hex SHA-256 of the normalized user code (`ABCD-EFGH`). */
  userCodeHash: string;
  status: DeviceCodeStatus;
  /** Machine name / OS the CLI reported, shown on the approve page. */
  name?: string;
  os?: string;
  /** Hex SHA-256 of the agent's `machineKey`, if sent. */
  machineKeyHash?: string;
  /** Set on approval. */
  userId?: string;
  createdAt: string;
  expiresAt: string;
}

/** The run a session is executing, as last seen in its events (for `GET /runs?active=1`). */
export interface ActiveRunRecord {
  id: string;
  state: RunState;
  startedAt?: string;
}

/**
 * A session snapshot rebuilt from replicated events (`sessionStorage: 'site'`). `session` is absent
 * until the session's first `session.created` / `session.updated` event (or create result) arrives.
 */
export interface ReplicaSnapshot {
  session?: Session;
  runs: Run[];
  /** Approvals in state `pending` or `submitting`, oldest first. */
  pendingApprovals: ApprovalRequest[];
  lastSequence: number;
}

/**
 * Hub-side index of a session: which user owns it and which machine holds it. With
 * `sessionStorage: 'site'` it also carries the replicated snapshot and `lastSequence` (the highest
 * contiguous replicated event sequence).
 */
export interface SessionRecord {
  id: string;
  userId: string;
  machineId: string;
  createdAt: string;
  title: string;
  activeRun?: ActiveRunRecord;
  lastSequence: number;
  snapshot?: ReplicaSnapshot;
}

export type SessionPatch = {
  title?: string;
  /** `null` clears it. */
  activeRun?: ActiveRunRecord | null;
  snapshot?: ReplicaSnapshot;
};

/** Runs, approvals and attachments are routed through the session they belong to. */
export type ResourceKind = 'run' | 'approval' | 'attachment';

export interface AttachmentRecord {
  attachment: Attachment;
  userId: string;
  data: Uint8Array;
}

/** Outcome of a site tool call: `running` until it finishes. */
export type ToolCallStatus = 'running' | 'ok' | 'error' | 'invalid' | 'timeout' | 'cancelled';

/**
 * Audit row for one site tool call executed by the hub (what the browser sees live are the
 * runtime's own `tool.*` events; this is the website-side record).
 */
export interface ToolCallRecord {
  /** Hub-assigned id (`tcl_…`). */
  id: string;
  /** The machine's `tool_call` id. */
  callId: string;
  sessionId: string;
  runId: string;
  /** The session owner the handler ran as. */
  userId: string;
  machineId: string;
  tool: string;
  /** Arguments as sent by the machine (`null` when too large or not storable). */
  args: unknown;
  status: ToolCallStatus;
  /** `ok` with `isError` results and failures carry an error code / message. */
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export type ToolCallFinish = Required<Pick<ToolCallRecord, 'status' | 'finishedAt' | 'durationMs'>> & Pick<ToolCallRecord, 'errorCode' | 'errorMessage'>;

/**
 * Hub persistence. `pgliteHubStore` is the single-node default; multi-node deployments need a
 * store shared by every node. Every method is safe to call concurrently.
 */
export interface HubStore {
  insertMachine(m: MachineRecord): Promise<void>;
  getMachine(id: string): Promise<MachineRecord | null>;
  findMachineByTokenHash(tokenHash: string): Promise<MachineRecord | null>;
  /** The user's machine paired with this `machineKey` hash, if any. */
  findMachineByKey(userId: string, machineKeyHash: string): Promise<MachineRecord | null>;
  /** Replaces the machine's token hash (re-pairing); resolves `false` when there is no such machine. */
  rotateMachineToken(id: string, tokenHash: string): Promise<boolean>;
  /** Newest `lastSeenAt` first. */
  listMachines(userId: string): Promise<MachineRecord[]>;
  updateMachine(id: string, patch: Partial<Pick<MachineRecord, 'name' | 'os' | 'agentVersion' | 'runtimes' | 'lastSeenAt'>>): Promise<void>;
  /** Resolves `false` when there was no such machine. */
  deleteMachine(id: string): Promise<boolean>;

  /** Also prunes device codes that expired over an hour ago. */
  insertDeviceCode(r: DeviceCodeRecord): Promise<void>;
  getDeviceCode(deviceCodeHash: string): Promise<DeviceCodeRecord | null>;
  findDeviceCodeByUserCode(userCodeHash: string): Promise<DeviceCodeRecord | null>;
  /** Compare-and-set on `status`; resolves the updated record, or `null` if the status was not `from`. */
  transitionDeviceCode(
    deviceCodeHash: string,
    from: DeviceCodeStatus,
    to: DeviceCodeStatus,
    patch?: { userId?: string },
  ): Promise<DeviceCodeRecord | null>;

  /** Inserts unless the id exists; resolves the stored record (existing or new). */
  insertSession(r: SessionRecord): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | null>;
  /** Oldest first, like the daemon's session list. */
  listSessions(userId: string): Promise<SessionRecord[]>;
  updateSession(id: string, patch: SessionPatch): Promise<void>;
  /**
   * Replication: appends `events` (contiguous, starting at `expectedLastSequence + 1`) and applies
   * `patch`, atomically, only if the session's `lastSequence` is still `expectedLastSequence`.
   * Resolves `false` (nothing written) otherwise.
   */
  appendEvents(sessionId: string, expectedLastSequence: number, events: UncageEvent[], patch: SessionPatch): Promise<boolean>;
  /** Replicated events with `sequence > after`, ascending, at most `limit`. */
  readEvents(sessionId: string, after: number, limit: number): Promise<UncageEvent[]>;

  /** First writer wins: an existing id keeps its session. */
  putResource(id: string, kind: ResourceKind, sessionId: string): Promise<void>;
  getResource(id: string, kind: ResourceKind): Promise<{ sessionId: string } | null>;

  putAttachment(r: AttachmentRecord): Promise<void>;
  getAttachment(id: string): Promise<AttachmentRecord | null>;

  /** Tool-call audit: a row per call, inserted as `running`. */
  insertToolCall(r: ToolCallRecord): Promise<void>;
  finishToolCall(id: string, r: ToolCallFinish): Promise<void>;
  /** A session's tool calls in start order, at most `limit` (default 1000). */
  listToolCalls(sessionId: string, limit?: number): Promise<ToolCallRecord[]>;

  close(): Promise<void>;
}
