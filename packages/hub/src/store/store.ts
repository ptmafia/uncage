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

/**
 * Hub persistence. `pgliteHubStore` is the single-node default; multi-node deployments need a
 * store shared by every node. Every method is safe to call concurrently.
 */
export interface HubStore {
  insertMachine(m: MachineRecord): Promise<void>;
  getMachine(id: string): Promise<MachineRecord | null>;
  findMachineByTokenHash(tokenHash: string): Promise<MachineRecord | null>;
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

  close(): Promise<void>;
}
