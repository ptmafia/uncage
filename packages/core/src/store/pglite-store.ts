import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { formatEventId } from '@uncage/protocol';
import type {
  ApprovalRequest,
  EventEnvelope,
  EventType,
  Run,
  Session,
} from '@uncage/protocol';
import { UncageError } from '../errors.js';
import { MIGRATIONS } from './migrations.js';
import { approvals, events, idempotencyKeys, runs, sessions } from './schema.js';
import type { Store } from './store.js';

type SessionRow = typeof sessions.$inferSelect;
type RunRow = typeof runs.$inferSelect;
type EventRow = typeof events.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  runtimeId: r.runtimeId,
  workspace: r.workspace,
  title: r.title,
  status: r.status as Session['status'],
  readOnly: r.readOnly,
  createdAt: r.createdAt,
  capabilities: r.capabilities,
  settings: { permissionMode: 'default' }, // TODO(Task 2): persisted column
  ...(r.activeRunId !== null ? { activeRunId: r.activeRunId } : {}),
});

const toRun = (r: RunRow): Run => ({
  id: r.id,
  sessionId: r.sessionId,
  prompt: r.prompt,
  state: r.state as Run['state'],
  createdAt: r.createdAt,
  ...(r.startedAt !== null ? { startedAt: r.startedAt } : {}),
  ...(r.endedAt !== null ? { endedAt: r.endedAt } : {}),
  ...(r.error !== null ? { error: r.error } : {}),
});

const toEvent = (r: EventRow): EventEnvelope => ({
  eventId: formatEventId(r.sequence),
  sequence: r.sequence,
  sessionId: r.sessionId,
  ...(r.runId !== null ? { runId: r.runId } : {}),
  type: r.type as EventType,
  occurredAt: r.occurredAt.toISOString(),
  schemaVersion: '1.0',
  payload: r.payload as EventEnvelope['payload'],
  ...(r.extensions !== null ? { extensions: r.extensions as Record<string, unknown> } : {}),
});

const toApproval = (r: ApprovalRow): ApprovalRequest => ({
  id: r.id,
  sessionId: r.sessionId,
  runId: r.runId,
  ...(r.toolId !== null ? { toolId: r.toolId } : {}),
  runtimeId: r.runtimeId,
  category: r.category as ApprovalRequest['category'],
  title: r.title,
  ...(r.description !== null ? { description: r.description } : {}),
  target: r.target,
  allowedScopes: r.allowedScopes,
  availableDecisions: r.availableDecisions,
  state: r.state as ApprovalRequest['state'],
  ...(r.decision !== null ? { decision: r.decision as 'allow' | 'deny' } : {}),
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  version: r.version,
});

/**
 * Build a drizzle SET object from a patch. `id` is never patched. `undefined` values are
 * skipped, except for keys listed in `nullable`, where a present key clears the column.
 */
const buildSet = (patch: object, nullable: readonly string[], skip: readonly string[] = ['id']) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (skip.includes(k)) continue;
    if (v === undefined || v === null) {
      if (nullable.includes(k)) out[k] = null;
      continue;
    }
    out[k] = v;
  }
  return out;
};

const notFound = (what: string, id: string) =>
  new UncageError('not_found', { message: `${what} ${id} not found.` });

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Acquire `<dataDir>/uncage.lock` (contains our pid); stale locks (dead pid) are taken over. */
const acquireLock = (dataDir: string): (() => void) => {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, 'uncage.lock');
  const locked = () =>
    new UncageError('store_locked', {
      hint: `Another Uncage process is using ${dataDir}. Stop it or pass a different dataDir.`,
    });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return () => rmSync(lockPath, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
      if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) throw locked();
      rmSync(lockPath, { force: true }); // stale
    }
  }
  throw locked();
};

export async function openPgliteStore(opts: { dataDir: string | 'memory://' }): Promise<Store> {
  const inMemory = opts.dataDir === 'memory://';
  const release = inMemory ? () => undefined : acquireLock(opts.dataDir);
  let client: PGlite;
  try {
    client = new PGlite(opts.dataDir);
    await client.waitReady;
    await client.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = await client.query<{ id: number }>('SELECT id FROM schema_migrations');
    const applied = new Set(done.rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      await client.transaction(async (tx) => {
        await tx.exec(m.sql);
        await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
      });
    }
  } catch (e) {
    release();
    throw e;
  }
  const db = drizzle(client);

  const updateOne = async <T>(
    table: typeof sessions | typeof runs,
    id: string,
    set: Record<string, unknown>,
    map: (row: never) => T,
    what: string,
  ): Promise<T> => {
    const rows =
      Object.keys(set).length === 0
        ? await db.select().from(table).where(eq(table.id, id))
        : await db.update(table).set(set).where(eq(table.id, id)).returning();
    const row = rows[0];
    if (!row) throw notFound(what, id);
    return map(row as never);
  };

  const store: Store = {
    async createSession(s) {
      await db.insert(sessions).values({
        id: s.id,
        runtimeId: s.runtimeId,
        workspace: s.workspace,
        title: s.title,
        status: s.status,
        readOnly: s.readOnly,
        createdAt: s.createdAt,
        capabilities: s.capabilities,
        activeRunId: s.activeRunId ?? null,
        nativeSessionRef: s.nativeSessionRef ?? null,
      });
    },
    async getSession(id) {
      const [r] = await db.select().from(sessions).where(eq(sessions.id, id));
      if (!r) return null;
      const ref = opt(r.nativeSessionRef);
      return { ...toSession(r), ...(ref !== undefined ? { nativeSessionRef: ref } : {}), lastSequence: r.lastSequence };
    },
    async listSessions() {
      const rows = await db.select().from(sessions).orderBy(asc(sessions.createdAt), asc(sessions.id));
      return rows.map(toSession);
    },
    async updateSession(id, patch) {
      const set = buildSet(patch, ['activeRunId', 'nativeSessionRef'], ['id', 'lastSequence', 'prunedThrough']);
      return updateOne(sessions, id, set, toSession, 'Session');
    },

    async createRun(r) {
      await db.insert(runs).values({
        id: r.id,
        sessionId: r.sessionId,
        prompt: r.prompt,
        state: r.state,
        createdAt: r.createdAt,
        startedAt: r.startedAt ?? null,
        endedAt: r.endedAt ?? null,
        error: r.error ?? null,
      });
    },
    async getRun(id) {
      const [r] = await db.select().from(runs).where(eq(runs.id, id));
      return r ? toRun(r) : null;
    },
    async listRuns(sessionId) {
      const rows = await db.select().from(runs).where(eq(runs.sessionId, sessionId)).orderBy(asc(runs.createdAt), asc(runs.id));
      return rows.map(toRun);
    },
    async updateRun(id, patch) {
      const set = buildSet(patch, ['startedAt', 'endedAt', 'error']);
      return updateOne(runs, id, set, toRun, 'Run');
    },
    async listRunsInState(states) {
      if (states.length === 0) return [];
      const rows = await db.select().from(runs).where(inArray(runs.state, states)).orderBy(asc(runs.createdAt), asc(runs.id));
      return rows.map(toRun);
    },

    async appendEvent<K extends EventType>(
      e: Omit<EventEnvelope<K>, 'eventId' | 'sequence' | 'schemaVersion'>,
    ): Promise<EventEnvelope<K>> {
      // One transaction: the UPDATE takes the session row lock, so sequence allocation and the
      // insert are atomic; PGlite additionally serialises transactions on its single connection.
      const row = await db.transaction(async (tx) => {
        const [s] = await tx
          .update(sessions)
          .set({ lastSequence: sql`${sessions.lastSequence} + 1` })
          .where(eq(sessions.id, e.sessionId))
          .returning({ seq: sessions.lastSequence });
        if (!s) throw notFound('Session', e.sessionId);
        const [inserted] = await tx
          .insert(events)
          .values({
            sessionId: e.sessionId,
            sequence: s.seq,
            runId: e.runId ?? null,
            type: e.type,
            payload: e.payload,
            extensions: e.extensions ?? null,
            occurredAt: new Date(e.occurredAt),
          })
          .returning();
        return inserted as EventRow;
      });
      return { ...toEvent(row), occurredAt: e.occurredAt } as EventEnvelope<K>;
    },
    async readEvents(sessionId, afterSequence, limit) {
      const q = db
        .select()
        .from(events)
        .where(and(eq(events.sessionId, sessionId), gt(events.sequence, afterSequence)))
        .orderBy(asc(events.sequence));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(toEvent);
    },
    async minRetainedSequence(sessionId) {
      const [r] = await db.select({ p: sessions.prunedThrough }).from(sessions).where(eq(sessions.id, sessionId));
      return r && r.p > 0 ? r.p + 1 : 0;
    },
    async pruneEvents(olderThan) {
      return db.transaction(async (tx) => {
        const deleted = await tx
          .delete(events)
          .where(lt(events.occurredAt, olderThan))
          .returning({ sessionId: events.sessionId, sequence: events.sequence });
        const maxBySession = new Map<string, number>();
        for (const d of deleted) maxBySession.set(d.sessionId, Math.max(maxBySession.get(d.sessionId) ?? 0, d.sequence));
        for (const [sid, max] of maxBySession) {
          await tx
            .update(sessions)
            .set({ prunedThrough: sql`GREATEST(${sessions.prunedThrough}, ${max})` })
            .where(eq(sessions.id, sid));
        }
        return deleted.length;
      });
    },

    async createApproval(a) {
      await db.insert(approvals).values({
        id: a.id,
        sessionId: a.sessionId,
        runId: a.runId,
        toolId: a.toolId ?? null,
        runtimeId: a.runtimeId,
        category: a.category,
        title: a.title,
        description: a.description ?? null,
        target: a.target,
        allowedScopes: a.allowedScopes,
        availableDecisions: a.availableDecisions,
        state: a.state,
        decision: a.decision ?? null,
        createdAt: a.createdAt,
        expiresAt: a.expiresAt,
        version: a.version,
      });
    },
    async getApproval(id) {
      const [r] = await db.select().from(approvals).where(eq(approvals.id, id));
      return r ? toApproval(r) : null;
    },
    async listApprovals(q) {
      const where =
        q.states === undefined
          ? eq(approvals.sessionId, q.sessionId)
          : and(eq(approvals.sessionId, q.sessionId), inArray(approvals.state, q.states));
      if (q.states?.length === 0) return [];
      const rows = await db.select().from(approvals).where(where).orderBy(asc(approvals.createdAt), asc(approvals.id));
      return rows.map(toApproval);
    },
    async casApproval(id, expect, next) {
      const set = buildSet(next, ['toolId', 'description', 'decision']);
      if (Object.keys(set).length === 0) {
        const [r] = await db
          .select()
          .from(approvals)
          .where(and(eq(approvals.id, id), eq(approvals.state, expect.state), eq(approvals.version, expect.version)));
        return r ? toApproval(r) : null;
      }
      const [r] = await db
        .update(approvals)
        .set(set)
        .where(and(eq(approvals.id, id), eq(approvals.state, expect.state), eq(approvals.version, expect.version)))
        .returning();
      return r ? toApproval(r) : null;
    },

    async getIdempotent(key, scope) {
      const [r] = await db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
      return r ? { requestHash: r.requestHash, response: r.response } : null;
    },
    async putIdempotent(key, scope, requestHash, response) {
      await db
        .insert(idempotencyKeys)
        .values({ scope, key, requestHash, response })
        .onConflictDoNothing();
    },

    async close() {
      try {
        if (!client.closed) await client.close();
      } finally {
        release();
      }
    },
  };
  return store;
}
