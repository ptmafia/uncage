import type { ApprovalRequest, Attachment, HubFrame, Run, RunState, RuntimeInfo, Session, TransportKind, UncageEvent } from '@uncage/protocol';

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
  /** When the hub last refused the machine for an outdated agent (shown as "please upgrade"). */
  outdatedAt?: string;
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
  /** The session's runtime id (`claude`, `codex`, …); absent on rows written by older hubs. */
  runtime?: string;
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
  /** The machine the attachment was relayed to (its bytes are deleted when that machine is revoked). */
  machineId?: string;
}

/**
 * Outcome of a site tool call: `running` until it finishes. `interrupted`: the instance running it
 * died (its lease ran out); the call is failed, never re-run.
 */
export type ToolCallStatus = 'running' | 'ok' | 'error' | 'invalid' | 'timeout' | 'cancelled' | 'interrupted';

export type ToolResultFrame = Extract<HubFrame, { t: 'tool_result' }>;

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
  /** While `running`: the executing instance's lease (ISO); past it the call is stale. */
  leaseUntil?: string;
  /** Once finished: the `tool_result` frame sent to the machine (redelivered on a retried call). */
  result?: ToolResultFrame;
}

/** What `claimToolCall` found for a `(machineId, callId)`. */
export type ToolCallClaim =
  | { kind: 'new' }
  | { kind: 'running' }
  | { kind: 'stale'; record: ToolCallRecord }
  | { kind: 'done'; record: ToolCallRecord & { result: ToolResultFrame } };

/** One durable hub → machine message, numbered per machine. */
export interface OutboxItem {
  seq: number;
  msgId: string;
  msg: HubFrame;
  expiresAt: string;
}

/** Whether a link is still the machine's current one (`gone`: no link, closed, or machine deleted). */
export type LinkState = 'current' | 'replaced' | 'gone';

export type ToolCallFinish = Required<Pick<ToolCallRecord, 'status' | 'finishedAt' | 'durationMs'>> & Pick<ToolCallRecord, 'errorCode' | 'errorMessage'>;

/**
 * Hub persistence. `pgliteHubStore` is the single-node default; multi-node deployments need a
 * store shared by every node. Every method is safe to call concurrently.
 *
 * Timestamps are ISO strings from `Date.prototype.toISOString()` (UTC, millisecond precision):
 * leases, expiries and pruning compare them as text, which is only correct in that one format.
 * They come from the instances' clocks, not the database's: instances must keep their clocks in
 * sync (NTP) to well within the shortest lease grace (tool calls: `toolLeaseGraceMs`, 10 s), or a
 * skewed instance could see another's lease as expired early.
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
  /**
   * Also deletes the attachment bytes relayed to that machine and its link, outbox and inbox rows.
   * Resolves `false` when there was no such machine.
   */
  deleteMachine(id: string): Promise<boolean>;
  markMachineOutdated(id: string, at: string): Promise<void>;

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
  /** Records a poll of a device code; resolves the previous poll time (`null`: first poll or no such code). */
  recordDevicePoll(deviceCodeHash: string, at: string): Promise<string | null>;

  /** Inserts unless the id exists; resolves the stored record (existing or new). */
  insertSession(r: SessionRecord): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | null>;
  /** Oldest first, like the daemon's session list. */
  listSessions(userId: string): Promise<SessionRecord[]>;
  updateSession(id: string, patch: SessionPatch): Promise<void>;
  /** Deletes a session record and its replicated events (a session the machine refused to create). */
  deleteSession(id: string): Promise<void>;
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
  /** Retention: deletes attachments (bytes and metadata) created before `before` (ISO). Resolves how many. */
  pruneAttachments(before: string): Promise<number>;

  /**
   * The site tools a run was offered (its manifest), recorded before `startRun` is sent under
   * `key` (`<sessionId>:<idempotencyKey>`); first writer wins. Tool calls are only accepted for
   * tools in their run's set.
   */
  putRunManifest(r: { key: string; sessionId: string; tools: string[]; createdAt: string; nonce: string }): Promise<void>;
  /**
   * Links the manifest stored under `key` to `runId` (no-op if either is already linked; a lost
   * race for the same run is not an error). Other database errors reject.
   */
  bindRunManifest(key: string, runId: string): Promise<void>;
  /**
   * Drops an unlinked manifest whose startRun was refused — only if `nonce` is the one this
   * request stored (a concurrent same-key retry that did not create the row must not delete it).
   */
  deleteRunManifest(key: string, nonce: string): Promise<void>;
  /**
   * Retention: deletes unlinked manifests created before `unboundBefore` and linked ones created
   * before `boundBefore`. Resolves how many rows were deleted.
   */
  pruneRunManifests(o: { unboundBefore: string; boundBefore: string }): Promise<number>;
  /** The run's session and offered tool names, or `null` when the run has no manifest (yet). */
  getRunTools(runId: string): Promise<{ sessionId: string; tools: string[] } | null>;

  /** Tool-call audit: a row per call, inserted as `running`. */
  insertToolCall(r: ToolCallRecord): Promise<void>;
  /**
   * Inserts `r` as `running` with `leaseUntil` unless `(r.machineId, r.callId)` exists. Otherwise
   * reports the existing call: `running` (lease still valid at `now`), `stale` (lease over: its
   * instance died) or `done` (with the stored result). Never extends an existing lease.
   */
  claimToolCall(r: ToolCallRecord, o: { leaseUntil: string; now: string }): Promise<ToolCallClaim>;
  /** Compare-and-set: finishes the call only while it is `running`; resolves whether it did. */
  finishToolCall(id: string, r: ToolCallFinish & { result: ToolResultFrame }): Promise<boolean>;
  /** The call `(machineId, callId)` as stored (any status), or `null`. Never writes. */
  getToolCall(machineId: string, callId: string): Promise<ToolCallRecord | null>;
  /**
   * Retention: drops the stored `result` of calls finished before `before` (status and the rest of
   * the audit row stay). A resend of such a call is answered with a generic "already finished" error.
   */
  pruneToolCallResults(before: string): Promise<number>;
  /** Running calls whose lease ended before `now`, oldest lease first. */
  listStaleToolCalls(now: string, limit: number): Promise<ToolCallRecord[]>;
  /** A session's tool calls in start order, at most `limit` (default 1000). */
  listToolCalls(sessionId: string, limit?: number): Promise<ToolCallRecord[]>;

  /**
   * Opens (or replaces) the machine's link. Seqs and the acked position belong to the machine and
   * survive links; resolves the acked seq.
   */
  openLink(machineId: string, l: { linkId: string; transport: TransportKind; at: string }): Promise<{ ackedSeq: number }>;
  /** Unexpired outbox items with `seq > after`, ascending, at most `limit` (none unless `current`). */
  pollLink(machineId: string, linkId: string, o: { after: number; limit: number; now: string }): Promise<{ state: LinkState; busy: boolean; items: OutboxItem[] }>;
  /**
   * On the current link only: `ackedSeq` only moves forward (capped at the last enqueued seq) and
   * deletes outbox items `seq <= ackedSeq`; `busy` is the machine's own flag.
   */
  updateLink(machineId: string, linkId: string, p: { ackedSeq?: number; busy?: boolean; at: string }): Promise<LinkState>;
  /** Closes `linkId` if it is current (`null`: whichever link is current). Outbox and seqs stay. */
  closeLink(machineId: string, linkId: string | null): Promise<void>;
  /**
   * Appends to the machine's outbox; resolves the per-machine seqs, monotonic and gap-free in
   * commit order (a reader never sees a seq before every lower one is visible). Resolves `'gone'`
   * (nothing written) when the machine does not exist.
   */
  enqueueOutbox(machineId: string, items: Array<{ msgId: string; msg: HubFrame; expiresAt: string }>, at: string): Promise<number[] | 'gone'>;

  /**
   * Upstream dedupe: claims each message id for processing until `leaseUntil`. `new`: process it;
   * `busy`: another instance holds it; `done`: already processed. An expired claim is `new` again.
   */
  claimInbox(machineId: string, msgIds: string[], o: { leaseUntil: string; now: string }): Promise<Record<string, 'new' | 'done' | 'busy'>>;
  completeInbox(machineId: string, msgIds: string[], at: string): Promise<void>;
  /**
   * Gives up claims that are still `processing` (handling failed): the next claim of those ids is
   * `new` at once instead of waiting for the lease. `done` rows stay.
   */
  releaseInbox(machineId: string, msgIds: string[]): Promise<void>;

  /** Fixed-window counter shared by every instance; atomic. `retryAfterMs` is 0 when allowed. */
  hitRateLimit(key: string, o: { max: number; windowMs: number; nowMs: number }): Promise<{ allowed: boolean; retryAfterMs: number }>;
  /** Gives back one hit in the current window (e.g. a successful attempt that should not count). */
  releaseRateLimit(key: string, o: { windowMs: number; nowMs: number }): Promise<void>;
  /** Takes or renews the named lease; resolves `false` while another holder's lease runs. */
  tryLease(name: string, o: { holder: string; until: string; now: string }): Promise<boolean>;
  /**
   * Retention for the transport tables: expired outbox items, inbox rows last touched before
   * `inboxBefore` (done or lease over; `inboxBefore` must be older than the longest window in
   * which an agent may still resend a message, or a late resend would run twice), rate-limit windows starting before `rateLimitBeforeMs`,
   * device codes expired over an hour before `now`. Resolves how many rows each lost.
   */
  pruneTransport(o: { now: string; inboxBefore: string; rateLimitBeforeMs: number }): Promise<{ outbox: number; inbox: number; rateLimits: number; deviceCodes: number }>;

  close(): Promise<void>;
}
