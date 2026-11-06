import type {
  ApprovalRequest,
  Attachment,
  ApprovalState,
  EventEnvelope,
  EventType,
  Run,
  RunState,
  Session,
} from '@uncage/protocol';

/** An attachment row: the public attachment plus its file location and consuming run. */
export type StoredAttachment = Attachment & { absPath: string; referencedByRun?: string };

export interface Store {
  createSession(s: Session & { nativeSessionRef?: string }): Promise<void>;
  getSession(id: string): Promise<(Session & { nativeSessionRef?: string; lastSequence: number }) | null>;
  listSessions(): Promise<Session[]>;
  /** Keys present in `patch` with value `undefined`/`null` clear nullable fields (activeRunId, nativeSessionRef). */
  updateSession(id: string, patch: Partial<Session> & { nativeSessionRef?: string | null }): Promise<Session>;
  /** `r.attachments` is not stored here; runs are hydrated from attachments referenced by them. */
  createRun(r: Run): Promise<void>;
  getRun(id: string): Promise<Run | null>;
  listRuns(sessionId: string): Promise<Run[]>;
  updateRun(id: string, patch: Partial<Run>): Promise<Run>;
  listRunsInState(states: RunState[]): Promise<Run[]>;
  appendEvent<K extends EventType>(
    e: Omit<EventEnvelope<K>, 'eventId' | 'sequence' | 'schemaVersion'>,
  ): Promise<EventEnvelope<K>>;
  readEvents(sessionId: string, afterSequence: number, limit?: number): Promise<EventEnvelope[]>;
  /** 0 when nothing was pruned; otherwise the lowest sequence that may still be retained. */
  minRetainedSequence(sessionId: string): Promise<number>;
  pruneEvents(olderThan: Date): Promise<number>;
  createApproval(a: ApprovalRequest): Promise<void>;
  getApproval(id: string): Promise<ApprovalRequest | null>;
  listApprovals(q: { sessionId: string; states?: ApprovalState[] }): Promise<ApprovalRequest[]>;
  /** Atomic compare-and-swap on (state, version). Returns null when the race was lost. */
  casApproval(
    id: string,
    expect: { state: ApprovalState; version: number },
    next: Partial<ApprovalRequest>,
  ): Promise<ApprovalRequest | null>;
  createAttachment(a: StoredAttachment): Promise<void>;
  getAttachment(id: string): Promise<StoredAttachment | null>;
  /** Returns the existing rows among `ids` (missing ids are simply absent). */
  listAttachments(ids: string[]): Promise<StoredAttachment[]>;
  /** Sets `referencedByRun` on those of `ids` not yet referenced; returns how many were marked. */
  markAttachmentsReferenced(ids: string[], runId: string): Promise<number>;
  /** Deletes unreferenced attachments created before `olderThan`; returns the deleted rows. */
  deleteOrphanAttachments(olderThan: Date): Promise<StoredAttachment[]>;
  getIdempotent(key: string, scope: string): Promise<{ requestHash: string; response: unknown } | null>;
  putIdempotent(key: string, scope: string, requestHash: string, response: unknown): Promise<void>;
  close(): Promise<void>;
}
