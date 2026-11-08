import { basename } from 'node:path';
import {
  newId,
  type CreateSessionBody,
  type Run,
  type Session,
  type SessionSettings,
  type SessionSnapshot,
  type StartRunBody,
  type UncageEvent,
} from '@uncage/protocol';
import { UncageError } from './errors.js';
import type { EventLog } from './event-log.js';
import type { AdapterRegistry } from './registry.js';
import type { RunManager, StartRunOptions } from './runs.js';
import { mergeSettings, type SecurityPolicy } from './settings.js';
import type { Store } from './store/store.js';
import { resolveWorkspace } from './workspace.js';

export interface SessionHandle {
  readonly id: string;
  get(): Promise<Session>;
  snapshot(): Promise<SessionSnapshot>;
  /**
   * Returns once the run is queued; execution continues in the background. `manifest` (connected
   * mode) offers site tools and skills to the runtime for this run; tool calls go to `callTool`.
   */
  startRun(b: StartRunBody & StartRunOptions): Promise<Run>;
  /** Replays from the store, then streams live events. Never ends on its own; abort via `signal`. */
  events(opts?: { after?: number; signal?: AbortSignal }): AsyncIterable<UncageEvent>;
}

export interface WorkspaceConfig {
  allowedRoots: string[];
  default: string;
}

/** Shape of ids from `newId('ses')`; a caller-chosen id must match it. */
const SESSION_ID = /^ses_[a-z0-9]{8,64}$/;

/** Longest title derived from a prompt, in characters (code points). */
export const MAX_TITLE_LENGTH = 60;

/** A session title from a prompt: whitespace collapsed, trimmed, cut to 60 characters with `…`. */
export function titleFromPrompt(prompt: string): string {
  const chars = [...prompt.replace(/\s+/g, ' ').trim()];
  if (chars.length <= MAX_TITLE_LENGTH) return chars.join('');
  return `${chars.slice(0, MAX_TITLE_LENGTH - 1).join('').trimEnd()}…`;
}

/** Strips store-internal fields from a stored session. */
const toPublic = (stored: Session & { nativeSessionRef?: string; lastSequence?: number }): Session => {
  const s = { ...stored };
  delete s.nativeSessionRef;
  delete s.lastSequence;
  return s;
};

export class SessionService {
  /** Serialises settings read-merge-write per session. */
  private readonly settingsLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly log: EventLog,
    private readonly registry: AdapterRegistry,
    private readonly runs: RunManager,
    private readonly workspace: WorkspaceConfig,
    private readonly policy: SecurityPolicy,
  ) {}

  async create(b: CreateSessionBody, opts: { id?: string } = {}): Promise<SessionHandle> {
    if (opts.id !== undefined) {
      if (!SESSION_ID.test(opts.id)) throw new UncageError('invalid_request', { message: 'Invalid session id.' });
      if (await this.store.getSession(opts.id)) throw new UncageError('invalid_request', { message: `Session ${opts.id} already exists.` });
    }
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
      id: opts.id ?? newId('ses'),
      runtimeId: adapter.id,
      workspace,
      // Untitled sessions show the workspace folder until their first prompt names them (RunManager).
      title: b.title ?? basename(workspace),
      status: 'ready',
      readOnly: false,
      createdAt: new Date().toISOString(),
      capabilities: await this.registry.capabilities(adapter.id),
      settings: { permissionMode: 'default' },
    };
    await this.store.createSession(session);
    await this.log.append(session.id, 'session.created', { session });
    return this.handle(session.id);
  }

  async get(id: string): Promise<SessionHandle> {
    await this.load(id);
    return this.handle(id);
  }

  /**
   * Validates `patch` (policy first, then the runtime's current capabilities), persists the merged
   * settings and emits `session.updated`. Takes effect from the next run.
   */
  updateSettings(id: string, patch: Partial<SessionSettings>): Promise<Session> {
    const prev = this.settingsLocks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.updateSettingsLocked(id, patch));
    this.settingsLocks.set(id, next);
    void next
      .finally(() => {
        if (this.settingsLocks.get(id) === next) this.settingsLocks.delete(id);
      })
      .catch(() => undefined);
    return next;
  }

  private async updateSettingsLocked(id: string, patch: Partial<SessionSettings>): Promise<Session> {
    const current = await this.load(id);
    if (current.readOnly) throw new UncageError('session_read_only', { hint: 'Start a new session' });
    const caps = this.registry.find(current.runtimeId)
      ? await this.registry.capabilities(current.runtimeId)
      : current.capabilities;
    const settings = mergeSettings(current.settings, patch, caps, this.policy);
    const session = toPublic(await this.store.updateSession(id, { settings }));
    await this.log.append(id, 'session.updated', { session });
    return session;
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
