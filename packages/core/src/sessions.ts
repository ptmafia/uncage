import { basename } from 'node:path';
import {
  newId,
  type CreateSessionBody,
  type Run,
  type Session,
  type SessionSnapshot,
  type StartRunBody,
  type UncageEvent,
} from '@uncage/protocol';
import { UncageError } from './errors.js';
import type { EventLog } from './event-log.js';
import type { AdapterRegistry } from './registry.js';
import type { RunManager } from './runs.js';
import type { Store } from './store/store.js';
import { resolveWorkspace } from './workspace.js';

export interface SessionHandle {
  readonly id: string;
  get(): Promise<Session>;
  snapshot(): Promise<SessionSnapshot>;
  /** Returns once the run is queued; execution continues in the background. */
  startRun(b: StartRunBody & { idempotencyKey?: string }): Promise<Run>;
  /** Replays from the store, then streams live events. Never ends on its own; abort via `signal`. */
  events(opts?: { after?: number; signal?: AbortSignal }): AsyncIterable<UncageEvent>;
}

export interface WorkspaceConfig {
  allowedRoots: string[];
  default: string;
}

/** Strips store-internal fields from a stored session. */
const toPublic = (stored: Session & { nativeSessionRef?: string; lastSequence?: number }): Session => {
  const s = { ...stored };
  delete s.nativeSessionRef;
  delete s.lastSequence;
  return s;
};

export class SessionService {
  constructor(
    private readonly store: Store,
    private readonly log: EventLog,
    private readonly registry: AdapterRegistry,
    private readonly runs: RunManager,
    private readonly workspace: WorkspaceConfig,
  ) {}

  async create(b: CreateSessionBody): Promise<SessionHandle> {
    const adapter = this.registry.require(b.runtime);
    const info = await this.registry.info(adapter.id);
    if (info.status !== 'available') {
      throw new UncageError(info.status === 'auth_required' ? 'auth_required' : 'runtime_unavailable', {
        ...(info.message !== undefined ? { message: info.message } : {}),
        ...(info.hint !== undefined ? { hint: info.hint } : {}),
        details: { runtime: adapter.id, status: info.status },
      });
    }
    const workspace = await resolveWorkspace(b.workspace, this.workspace);
    const session: Session = {
      id: newId('ses'),
      runtimeId: adapter.id,
      workspace,
      title: b.title ?? basename(workspace),
      status: 'ready',
      readOnly: false,
      createdAt: new Date().toISOString(),
      capabilities: adapter.capabilities(),
    };
    await this.store.createSession(session);
    await this.log.append(session.id, 'session.created', { session });
    return this.handle(session.id);
  }

  async get(id: string): Promise<SessionHandle> {
    await this.load(id);
    return this.handle(id);
  }

  async list(): Promise<Session[]> {
    return this.store.listSessions();
  }

  private async load(id: string): Promise<Session> {
    const s = await this.store.getSession(id);
    if (!s) throw new UncageError('not_found', { message: `Session ${id} not found.` });
    return toPublic(s);
  }

  private handle(id: string): SessionHandle {
    return {
      id,
      get: () => this.load(id),
      snapshot: async () => {
        const s = await this.store.getSession(id);
        if (!s) throw new UncageError('not_found', { message: `Session ${id} not found.` });
        const [runs, pendingApprovals] = await Promise.all([
          this.store.listRuns(id),
          this.store.listApprovals({ sessionId: id, states: ['pending', 'submitting'] }),
        ]);
        return { session: toPublic(s), runs, pendingApprovals, lastSequence: s.lastSequence };
      },
      startRun: (b) => this.runs.start(id, b),
      events: (opts = {}) => ({
        [Symbol.asyncIterator]: () => this.log.read(id, opts.after ?? 0, opts.signal),
      }),
    };
  }
}
