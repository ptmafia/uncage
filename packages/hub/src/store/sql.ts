import type { Attachment, HubFrame, RuntimeInfo, UncageEvent } from '@uncage/protocol';
import type {
  ActiveRunRecord,
  AttachmentRecord,
  DeviceCodeRecord,
  DeviceCodeStatus,
  HubStore,
  MachineRecord,
  ReplicaSnapshot,
  ResourceKind,
  SessionPatch,
  SessionRecord,
  LinkState,
  OutboxItem,
  ToolCallRecord,
  ToolCallStatus,
  ToolResultFrame,
} from './store.js';

/** The slice of a Postgres client the SQL store needs (PGlite and node-postgres both fit). */
export interface SqlQueryable {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface SqlClient extends SqlQueryable {
  /** Runs `fn` in a transaction; a throw rolls it back. */
  transaction<T>(fn: (tx: SqlQueryable) => Promise<T>): Promise<T>;
}

/** Plain Postgres DDL (no extensions), applied in order and recorded in `uncage_hub_migrations`. */
export const HUB_MIGRATIONS: readonly { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE uncage_hub_machines (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  name text NOT NULL,
  os text NOT NULL,
  agent_version text NOT NULL,
  runtimes jsonb NOT NULL,
  created_at text NOT NULL,
  last_seen_at text NOT NULL
);
CREATE INDEX uncage_hub_machines_user_idx ON uncage_hub_machines (user_id);
CREATE TABLE uncage_hub_device_codes (
  device_code_hash text PRIMARY KEY,
  user_code_hash text NOT NULL UNIQUE,
  status text NOT NULL,
  name text,
  os text,
  user_id text,
  created_at text NOT NULL,
  expires_at text NOT NULL
);
CREATE TABLE uncage_hub_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  machine_id text NOT NULL,
  created_at text NOT NULL,
  title text NOT NULL,
  active_run jsonb,
  last_sequence integer NOT NULL DEFAULT 0,
  snapshot jsonb
);
CREATE INDEX uncage_hub_sessions_user_idx ON uncage_hub_sessions (user_id);
CREATE TABLE uncage_hub_resources (
  id text NOT NULL,
  kind text NOT NULL,
  session_id text NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE uncage_hub_events (
  session_id text NOT NULL,
  sequence integer NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY (session_id, sequence)
);
CREATE TABLE uncage_hub_attachments (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  meta jsonb NOT NULL,
  data bytea NOT NULL
);
`,
  },
  {
    id: 2,
    sql: `
ALTER TABLE uncage_hub_machines ADD COLUMN machine_key_hash text;
CREATE INDEX uncage_hub_machines_key_idx ON uncage_hub_machines (user_id, machine_key_hash);
ALTER TABLE uncage_hub_device_codes ADD COLUMN machine_key_hash text
`,
  },
  {
    id: 3,
    sql: `
CREATE TABLE uncage_hub_tool_calls (
  id text PRIMARY KEY,
  call_id text NOT NULL,
  session_id text NOT NULL,
  run_id text NOT NULL,
  user_id text NOT NULL,
  machine_id text NOT NULL,
  tool text NOT NULL,
  args jsonb,
  status text NOT NULL,
  error_code text,
  error_message text,
  started_at text NOT NULL,
  finished_at text,
  duration_ms integer
);
CREATE INDEX uncage_hub_tool_calls_session_idx ON uncage_hub_tool_calls (session_id, started_at)
`,
  },
  {
    id: 4,
    sql: `
CREATE TABLE uncage_hub_run_manifests (
  key text PRIMARY KEY,
  session_id text NOT NULL,
  run_id text UNIQUE,
  tools jsonb NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX uncage_hub_run_manifests_session_idx ON uncage_hub_run_manifests (session_id, created_at)
`,
  },
  {
    id: 5,
    sql: `
ALTER TABLE uncage_hub_run_manifests ADD COLUMN nonce text;
CREATE INDEX uncage_hub_run_manifests_created_idx ON uncage_hub_run_manifests (created_at)
`,
  },
  {
    id: 6,
    sql: `
ALTER TABLE uncage_hub_sessions ADD COLUMN runtime text;
ALTER TABLE uncage_hub_attachments ADD COLUMN machine_id text;
ALTER TABLE uncage_hub_attachments ADD COLUMN created_at text;
CREATE INDEX uncage_hub_attachments_machine_idx ON uncage_hub_attachments (machine_id);
CREATE INDEX uncage_hub_attachments_created_idx ON uncage_hub_attachments (created_at)
`,
  },
  {
    // HTTP transport and stateless instances: per-machine link + durable outbox (seq allocated
    // from the link row), upstream inbox dedupe, shared rate-limit windows and leases, tool-call
    // leases and stored results.
    //
    // Before the unique (machine_id, call_id) index: an older hub could write two audit rows for
    // one resent call id. Audit rows are never deleted; later duplicates get their call_id
    // suffixed with '#<row id>' so the index can be created and every row stays readable.
    // (No semicolons inside statements: migrations are split on them.)
    id: 7,
    sql: `
CREATE TABLE uncage_hub_links (
  machine_id text PRIMARY KEY,
  link_id text NOT NULL,
  transport text NOT NULL,
  next_seq bigint NOT NULL DEFAULT 0,
  acked_seq bigint NOT NULL DEFAULT 0,
  busy boolean NOT NULL DEFAULT false,
  updated_at text NOT NULL
);
CREATE TABLE uncage_hub_outbox (
  machine_id text,
  seq bigint,
  msg_id text NOT NULL,
  msg jsonb NOT NULL,
  expires_at text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (machine_id, seq)
);
CREATE INDEX uncage_hub_outbox_expires_idx ON uncage_hub_outbox (expires_at);
CREATE TABLE uncage_hub_inbox (
  machine_id text,
  msg_id text,
  state text NOT NULL,
  lease_until text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (machine_id, msg_id)
);
CREATE INDEX uncage_hub_inbox_updated_idx ON uncage_hub_inbox (updated_at);
CREATE TABLE uncage_hub_rate_limits (
  key text,
  window_start bigint,
  count integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX uncage_hub_rate_limits_window_idx ON uncage_hub_rate_limits (window_start);
CREATE TABLE uncage_hub_leases (
  name text PRIMARY KEY,
  holder text NOT NULL,
  until text NOT NULL
);
ALTER TABLE uncage_hub_tool_calls ADD result jsonb, ADD lease_until text;
UPDATE uncage_hub_tool_calls a SET call_id = a.call_id || '#' || a.id
  FROM uncage_hub_tool_calls b
  WHERE a.machine_id = b.machine_id AND a.call_id = b.call_id AND (a.started_at, a.id) > (b.started_at, b.id);
CREATE UNIQUE INDEX uncage_hub_tool_calls_call_idx ON uncage_hub_tool_calls (machine_id, call_id);
CREATE INDEX uncage_hub_tool_calls_lease_idx ON uncage_hub_tool_calls (lease_until) WHERE status = 'running';
ALTER TABLE uncage_hub_device_codes ADD last_poll_at text;
CREATE INDEX uncage_hub_device_codes_expires_idx ON uncage_hub_device_codes (expires_at);
ALTER TABLE uncage_hub_machines ADD outdated_at text
`,
  },
];

/** Postgres `unique_violation` (PGlite reports the same SQLSTATE). */
const isUniqueViolation = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === '23505';

/** Applies pending migrations. Callers serialize concurrent first starts (e.g. an advisory lock). */
export async function migrateHubStore(db: SqlClient): Promise<void> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS uncage_hub_migrations (id integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const done = await db.query<{ id: number }>('SELECT id FROM uncage_hub_migrations');
  const applied = new Set(done.rows.map((r) => r.id));
  for (const m of HUB_MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await db.transaction(async (tx) => {
      for (const stmt of m.sql.split(';').map((s) => s.trim()).filter(Boolean)) await tx.query(stmt);
      await tx.query('INSERT INTO uncage_hub_migrations (id) VALUES ($1)', [m.id]);
    });
  }
}

interface MachineRow {
  id: string;
  user_id: string;
  token_hash: string;
  name: string;
  os: string;
  agent_version: string;
  runtimes: RuntimeInfo[];
  created_at: string;
  last_seen_at: string;
  machine_key_hash: string | null;
  outdated_at: string | null;
}
interface DeviceRow {
  device_code_hash: string;
  user_code_hash: string;
  status: DeviceCodeStatus;
  name: string | null;
  os: string | null;
  user_id: string | null;
  machine_key_hash: string | null;
  created_at: string;
  expires_at: string;
}
interface SessionRow {
  id: string;
  user_id: string;
  machine_id: string;
  created_at: string;
  title: string;
  active_run: ActiveRunRecord | null;
  last_sequence: number;
  snapshot: ReplicaSnapshot | null;
  runtime: string | null;
}

const toMachine = (r: MachineRow): MachineRecord => ({
  id: r.id,
  userId: r.user_id,
  tokenHash: r.token_hash,
  name: r.name,
  os: r.os,
  agentVersion: r.agent_version,
  runtimes: r.runtimes,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  ...(r.machine_key_hash !== null ? { machineKeyHash: r.machine_key_hash } : {}),
  ...(r.outdated_at !== null && r.outdated_at !== undefined ? { outdatedAt: r.outdated_at } : {}),
});

const toDevice = (r: DeviceRow): DeviceCodeRecord => ({
  deviceCodeHash: r.device_code_hash,
  userCodeHash: r.user_code_hash,
  status: r.status,
  ...(r.name !== null ? { name: r.name } : {}),
  ...(r.os !== null ? { os: r.os } : {}),
  ...(r.user_id !== null ? { userId: r.user_id } : {}),
  ...(r.machine_key_hash !== null ? { machineKeyHash: r.machine_key_hash } : {}),
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

const toSession = (r: SessionRow): SessionRecord => ({
  id: r.id,
  userId: r.user_id,
  machineId: r.machine_id,
  createdAt: r.created_at,
  title: r.title,
  ...(r.active_run !== null ? { activeRun: r.active_run } : {}),
  lastSequence: r.last_sequence,
  ...(r.snapshot !== null ? { snapshot: r.snapshot } : {}),
  ...(r.runtime !== null ? { runtime: r.runtime } : {}),
});

interface ToolCallRow {
  id: string;
  call_id: string;
  session_id: string;
  run_id: string;
  user_id: string;
  machine_id: string;
  tool: string;
  args: unknown;
  status: ToolCallStatus;
  error_code: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  lease_until: string | null;
  result: ToolResultFrame | null;
}

const toToolCall = (r: ToolCallRow): ToolCallRecord => ({
  id: r.id,
  callId: r.call_id,
  sessionId: r.session_id,
  runId: r.run_id,
  userId: r.user_id,
  machineId: r.machine_id,
  tool: r.tool,
  args: r.args ?? null,
  status: r.status,
  ...(r.error_code !== null ? { errorCode: r.error_code } : {}),
  ...(r.error_message !== null ? { errorMessage: r.error_message } : {}),
  startedAt: r.started_at,
  ...(r.finished_at !== null ? { finishedAt: r.finished_at } : {}),
  ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
  ...(r.status === 'running' && r.lease_until !== null ? { leaseUntil: r.lease_until } : {}),
  ...(r.result !== null ? { result: r.result } : {}),
});

/** A finished call's result; rows finished before migration 7 have none, so one is rebuilt. */
const storedResult = (r: ToolCallRecord): ToolResultFrame =>
  r.result ?? {
    t: 'tool_result',
    id: r.callId,
    ok: false,
    error: {
      code: 'tool_failed',
      message: r.errorMessage ?? `Site tool "${r.tool}" already finished (${r.status}).`,
      retryable: false,
    },
  };

interface OutboxRow {
  seq: string | number;
  msg_id: string;
  msg: HubFrame;
  expires_at: string;
}
const toOutboxItem = (r: OutboxRow): OutboxItem => ({ seq: Number(r.seq), msgId: r.msg_id, msg: r.msg, expiresAt: r.expires_at });

const linkState = (row: { link_id: string } | undefined, linkId: string): LinkState =>
  !row || row.link_id === '' ? 'gone' : row.link_id === linkId ? 'current' : 'replaced';

const json = (v: unknown): string => JSON.stringify(v);

/** `SET` clause + params for a session patch, numbering params from `start`. */
function sessionSet(patch: SessionPatch, start: number): { sql: string[]; params: unknown[] } {
  const sql: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, v: unknown, cast = '') => {
    params.push(v);
    sql.push(`${col} = $${start + params.length - 1}${cast}`);
  };
  if (patch.title !== undefined) add('title', patch.title);
  if (patch.activeRun !== undefined) add('active_run', patch.activeRun === null ? null : json(patch.activeRun), '::jsonb');
  if (patch.snapshot !== undefined) add('snapshot', json(patch.snapshot), '::jsonb');
  return { sql, params };
}

class CasFailed extends Error {}

/** Rows per DELETE in `pruneTransport`. */
const PRUNE_BATCH = 5000;

/** A `HubStore` over any Postgres-compatible client. `close` is called by `HubStore.close()`. */
export function sqlHubStore(db: SqlClient, close: () => Promise<void>): HubStore {
  const one = async <R, T>(sql: string, params: unknown[], map: (r: R) => T): Promise<T | null> => {
    const { rows } = await db.query<R>(sql, params);
    return rows[0] ? map(rows[0]) : null;
  };

  return {
    async insertMachine(m) {
      await db.query(
        `INSERT INTO uncage_hub_machines (id, user_id, token_hash, name, os, agent_version, runtimes, created_at, last_seen_at, machine_key_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
        [m.id, m.userId, m.tokenHash, m.name, m.os, m.agentVersion, json(m.runtimes), m.createdAt, m.lastSeenAt, m.machineKeyHash ?? null],
      );
    },
    getMachine: (id) => one('SELECT * FROM uncage_hub_machines WHERE id = $1', [id], toMachine),
    findMachineByTokenHash: (hash) => one('SELECT * FROM uncage_hub_machines WHERE token_hash = $1', [hash], toMachine),
    findMachineByKey: (userId, keyHash) =>
      one(
        'SELECT * FROM uncage_hub_machines WHERE user_id = $1 AND machine_key_hash = $2 ORDER BY created_at LIMIT 1',
        [userId, keyHash],
        toMachine,
      ),
    async rotateMachineToken(id, tokenHash) {
      const { rows } = await db.query('UPDATE uncage_hub_machines SET token_hash = $2 WHERE id = $1 RETURNING id', [id, tokenHash]);
      return rows.length > 0;
    },
    async listMachines(userId) {
      const { rows } = await db.query<MachineRow>(
        'SELECT * FROM uncage_hub_machines WHERE user_id = $1 ORDER BY last_seen_at DESC, id',
        [userId],
      );
      return rows.map(toMachine);
    },
    async updateMachine(id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [id];
      const add = (col: string, v: unknown, cast = '') => {
        params.push(v);
        sets.push(`${col} = $${params.length}${cast}`);
      };
      if (patch.name !== undefined) add('name', patch.name);
      if (patch.os !== undefined) add('os', patch.os);
      if (patch.agentVersion !== undefined) add('agent_version', patch.agentVersion);
      if (patch.runtimes !== undefined) add('runtimes', json(patch.runtimes), '::jsonb');
      if (patch.lastSeenAt !== undefined) add('last_seen_at', patch.lastSeenAt);
      if (sets.length === 0) return;
      await db.query(`UPDATE uncage_hub_machines SET ${sets.join(', ')} WHERE id = $1`, params);
    },
    async deleteMachine(id) {
      return db.transaction(async (tx) => {
        // Lock order shared with enqueueOutbox (machine, then link, then outbox) and updateLink
        // (link, then outbox), so concurrent calls cannot deadlock.
        const { rows } = await tx.query('DELETE FROM uncage_hub_machines WHERE id = $1 RETURNING id', [id]);
        await tx.query('DELETE FROM uncage_hub_links WHERE machine_id = $1', [id]);
        await tx.query('DELETE FROM uncage_hub_outbox WHERE machine_id = $1', [id]);
        await tx.query('DELETE FROM uncage_hub_inbox WHERE machine_id = $1', [id]);
        // Its attachment bytes go too (rows from before migration 6 are matched through their session).
        await tx.query(
          `DELETE FROM uncage_hub_attachments WHERE machine_id = $1
             OR (machine_id IS NULL AND meta->>'sessionId' IN (SELECT id FROM uncage_hub_sessions WHERE machine_id = $1))`,
          [id],
        );
        return rows.length > 0;
      });
    },
    async markMachineOutdated(id, at) {
      await db.query('UPDATE uncage_hub_machines SET outdated_at = $2 WHERE id = $1', [id, at]);
    },

    async insertDeviceCode(r) {
      await db.query('DELETE FROM uncage_hub_device_codes WHERE expires_at < $1', [
        new Date(Date.parse(r.createdAt) - 3_600_000).toISOString(),
      ]);
      await db.query(
        `INSERT INTO uncage_hub_device_codes (device_code_hash, user_code_hash, status, name, os, user_id, created_at, expires_at, machine_key_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [r.deviceCodeHash, r.userCodeHash, r.status, r.name ?? null, r.os ?? null, r.userId ?? null, r.createdAt, r.expiresAt, r.machineKeyHash ?? null],
      );
    },
    getDeviceCode: (hash) => one('SELECT * FROM uncage_hub_device_codes WHERE device_code_hash = $1', [hash], toDevice),
    findDeviceCodeByUserCode: (hash) =>
      one('SELECT * FROM uncage_hub_device_codes WHERE user_code_hash = $1', [hash], toDevice),
    transitionDeviceCode: (hash, from, to, patch = {}) =>
      one(
        `UPDATE uncage_hub_device_codes SET status = $3, user_id = COALESCE($4, user_id)
         WHERE device_code_hash = $1 AND status = $2 RETURNING *`,
        [hash, from, to, patch.userId ?? null],
        toDevice,
      ),
    recordDevicePoll: (hash, at) =>
      // Row-locked read-then-write: concurrent polls each see the one before them.
      db.transaction(async (tx) => {
        const { rows } = await tx.query<{ last_poll_at: string | null }>(
          'SELECT last_poll_at FROM uncage_hub_device_codes WHERE device_code_hash = $1 FOR UPDATE',
          [hash],
        );
        if (!rows[0]) return null;
        await tx.query('UPDATE uncage_hub_device_codes SET last_poll_at = $2 WHERE device_code_hash = $1', [hash, at]);
        return rows[0].last_poll_at;
      }),

    async insertSession(r) {
      await db.query(
        `INSERT INTO uncage_hub_sessions (id, user_id, machine_id, created_at, title, active_run, last_sequence, snapshot, runtime)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9) ON CONFLICT (id) DO NOTHING`,
        [
          r.id,
          r.userId,
          r.machineId,
          r.createdAt,
          r.title,
          r.activeRun ? json(r.activeRun) : null,
          r.lastSequence,
          r.snapshot ? json(r.snapshot) : null,
          r.runtime ?? null,
        ],
      );
      const stored = await one('SELECT * FROM uncage_hub_sessions WHERE id = $1', [r.id], toSession);
      if (!stored) throw new Error(`session ${r.id} vanished after insert`);
      return stored;
    },
    getSession: (id) => one('SELECT * FROM uncage_hub_sessions WHERE id = $1', [id], toSession),
    async deleteSession(id) {
      await db.transaction(async (tx) => {
        await tx.query('DELETE FROM uncage_hub_events WHERE session_id = $1', [id]);
        await tx.query('DELETE FROM uncage_hub_sessions WHERE id = $1', [id]);
      });
    },
    async listSessions(userId) {
      const { rows } = await db.query<SessionRow>(
        'SELECT * FROM uncage_hub_sessions WHERE user_id = $1 ORDER BY created_at, id',
        [userId],
      );
      return rows.map(toSession);
    },
    async updateSession(id, patch) {
      const set = sessionSet(patch, 2);
      if (set.sql.length === 0) return;
      await db.query(`UPDATE uncage_hub_sessions SET ${set.sql.join(', ')} WHERE id = $1`, [id, ...set.params]);
    },
    async appendEvents(sessionId, expected, events, patch) {
      const last = events.at(-1)?.sequence ?? expected;
      const set = sessionSet(patch, 4);
      try {
        await db.transaction(async (tx) => {
          const { rows } = await tx.query(
            `UPDATE uncage_hub_sessions SET last_sequence = $3${set.sql.map((s) => `, ${s}`).join('')}
             WHERE id = $1 AND last_sequence = $2 RETURNING id`,
            [sessionId, expected, last, ...set.params],
          );
          if (rows.length === 0) throw new CasFailed();
          for (const e of events) {
            await tx.query(
              'INSERT INTO uncage_hub_events (session_id, sequence, event) VALUES ($1, $2, $3::jsonb) ON CONFLICT DO NOTHING',
              [sessionId, e.sequence, json(e)],
            );
          }
        });
        return true;
      } catch (e) {
        if (e instanceof CasFailed) return false;
        throw e;
      }
    },
    async readEvents(sessionId, after, limit) {
      const { rows } = await db.query<{ event: UncageEvent }>(
        'SELECT event FROM uncage_hub_events WHERE session_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3',
        [sessionId, after, limit],
      );
      return rows.map((r) => r.event);
    },

    async putResource(id, kind: ResourceKind, sessionId) {
      await db.query(
        'INSERT INTO uncage_hub_resources (id, kind, session_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [id, kind, sessionId],
      );
    },
    getResource: (id, kind) =>
      one<{ session_id: string }, { sessionId: string }>(
        'SELECT session_id FROM uncage_hub_resources WHERE id = $1 AND kind = $2',
        [id, kind],
        (r) => ({ sessionId: r.session_id }),
      ),

    async putAttachment(r) {
      await db.query(
        'INSERT INTO uncage_hub_attachments (id, user_id, meta, data, machine_id, created_at) VALUES ($1, $2, $3::jsonb, $4, $5, $6) ON CONFLICT DO NOTHING',
        [r.attachment.id, r.userId, json(r.attachment), r.data, r.machineId ?? null, r.attachment.createdAt],
      );
    },
    async pruneAttachments(before) {
      const { rows } = await db.query(
        `DELETE FROM uncage_hub_attachments WHERE COALESCE(created_at, meta->>'createdAt') < $1 RETURNING id`,
        [before],
      );
      return rows.length;
    },
    getAttachment: (id) =>
      one<{ user_id: string; meta: Attachment; data: Uint8Array; machine_id: string | null }, AttachmentRecord>(
        'SELECT user_id, meta, data, machine_id FROM uncage_hub_attachments WHERE id = $1',
        [id],
        (r) => ({ attachment: r.meta, userId: r.user_id, data: new Uint8Array(r.data), ...(r.machine_id ? { machineId: r.machine_id } : {}) }),
      ),

    async putRunManifest(r) {
      await db.query(
        'INSERT INTO uncage_hub_run_manifests (key, session_id, tools, created_at, nonce) VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT (key) DO NOTHING',
        [r.key, r.sessionId, json(r.tools), r.createdAt, r.nonce],
      );
    },
    async bindRunManifest(key, runId) {
      try {
        await db.query(
          `UPDATE uncage_hub_run_manifests SET run_id = $2
           WHERE key = $1 AND run_id IS NULL AND NOT EXISTS (SELECT 1 FROM uncage_hub_run_manifests WHERE run_id = $2)`,
          [key, runId],
        );
      } catch (e) {
        // Two binds of the same run id racing past the NOT EXISTS guard: the UNIQUE(run_id) index
        // let exactly one win, so the run is bound either way. Anything else (e.g. the database
        // going away) must surface.
        if (!isUniqueViolation(e)) throw e;
      }
    },
    async deleteRunManifest(key, nonce) {
      await db.query('DELETE FROM uncage_hub_run_manifests WHERE key = $1 AND nonce = $2 AND run_id IS NULL', [key, nonce]);
    },
    async pruneRunManifests(o) {
      const { rows } = await db.query(
        `DELETE FROM uncage_hub_run_manifests
         WHERE (run_id IS NULL AND created_at < $1) OR (run_id IS NOT NULL AND created_at < $2)
         RETURNING key`,
        [o.unboundBefore, o.boundBefore],
      );
      return rows.length;
    },
    getRunTools: (runId) =>
      one<{ tools: string[]; session_id: string }, { sessionId: string; tools: string[] }>(
        'SELECT tools, session_id FROM uncage_hub_run_manifests WHERE run_id = $1',
        [runId],
        (r) => ({ sessionId: r.session_id, tools: r.tools }),
      ),

    async insertToolCall(r) {
      await db.query(
        `INSERT INTO uncage_hub_tool_calls (id, call_id, session_id, run_id, user_id, machine_id, tool, args, status, error_code, error_message, started_at, finished_at, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14)`,
        [
          r.id,
          r.callId,
          r.sessionId,
          r.runId,
          r.userId,
          r.machineId,
          r.tool,
          r.args === null || r.args === undefined ? null : json(r.args),
          r.status,
          r.errorCode ?? null,
          r.errorMessage ?? null,
          r.startedAt,
          r.finishedAt ?? null,
          r.durationMs ?? null,
        ],
      );
    },
    async claimToolCall(r, o) {
      const { rows } = await db.query(
        `INSERT INTO uncage_hub_tool_calls (id, call_id, session_id, run_id, user_id, machine_id, tool, args, status, started_at, lease_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'running', $9, $10)
         ON CONFLICT (machine_id, call_id) DO NOTHING RETURNING id`,
        [
          r.id,
          r.callId,
          r.sessionId,
          r.runId,
          r.userId,
          r.machineId,
          r.tool,
          r.args === null || r.args === undefined ? null : json(r.args),
          r.startedAt,
          o.leaseUntil,
        ],
      );
      if (rows.length > 0) return { kind: 'new' };
      const existing = await one<ToolCallRow, { rec: ToolCallRecord; lease: string | null }>(
        'SELECT * FROM uncage_hub_tool_calls WHERE machine_id = $1 AND call_id = $2',
        [r.machineId, r.callId],
        (row) => ({ rec: toToolCall(row), lease: row.lease_until }),
      );
      // Deleted between the two statements (retention): the caller may retry; report it running.
      if (!existing) return { kind: 'running' };
      const { rec, lease } = existing;
      if (rec.status !== 'running') return { kind: 'done', record: { ...rec, result: storedResult(rec) } };
      // A running row without a lease predates leases (an older hub's audit row): treat as stale.
      if (lease !== null && lease >= o.now) return { kind: 'running' };
      return { kind: 'stale', record: rec };
    },
    async finishToolCall(id, r) {
      const { rows } = await db.query(
        `UPDATE uncage_hub_tool_calls
         SET status = $2, error_code = $3, error_message = $4, finished_at = $5, duration_ms = $6, result = $7::jsonb
         WHERE id = $1 AND status = 'running' RETURNING id`,
        [id, r.status, r.errorCode ?? null, r.errorMessage ?? null, r.finishedAt, Math.round(r.durationMs), json(r.result)],
      );
      return rows.length > 0;
    },
    async listStaleToolCalls(now, limit) {
      const { rows } = await db.query<ToolCallRow>(
        // Rows without a lease were written by an older hub: stale, as in claimToolCall.
        `SELECT * FROM uncage_hub_tool_calls WHERE status = 'running' AND (lease_until IS NULL OR lease_until < $1)
         ORDER BY started_at, id LIMIT $2`,
        [now, limit],
      );
      return rows.map(toToolCall);
    },
    async listToolCalls(sessionId, limit = 1000) {
      const { rows } = await db.query<ToolCallRow>(
        'SELECT * FROM uncage_hub_tool_calls WHERE session_id = $1 ORDER BY started_at, id LIMIT $2',
        [sessionId, limit],
      );
      return rows.map(toToolCall);
    },

    async openLink(machineId, l) {
      // Replaces whichever link was current; seqs and the acked position stay with the machine.
      const { rows } = await db.query<{ acked_seq: string | number }>(
        `INSERT INTO uncage_hub_links (machine_id, link_id, transport, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (machine_id) DO UPDATE SET link_id = EXCLUDED.link_id, transport = EXCLUDED.transport, busy = false, updated_at = EXCLUDED.updated_at
         RETURNING acked_seq`,
        [machineId, l.linkId, l.transport, l.at],
      );
      return { ackedSeq: Number(rows[0]!.acked_seq) };
    },
    async pollLink(machineId, linkId, o) {
      const { rows } = await db.query<{ link_id: string; busy: boolean }>(
        'SELECT link_id, busy FROM uncage_hub_links WHERE machine_id = $1',
        [machineId],
      );
      const state = linkState(rows[0], linkId);
      if (state !== 'current') return { state, busy: false, items: [] };
      const items = await db.query<OutboxRow>(
        `SELECT seq, msg_id, msg, expires_at FROM uncage_hub_outbox
         WHERE machine_id = $1 AND seq > $2 AND expires_at > $3 ORDER BY seq LIMIT $4`,
        [machineId, o.after, o.now, o.limit],
      );
      return { state, busy: rows[0]!.busy, items: items.rows.map(toOutboxItem) };
    },
    updateLink: (machineId, linkId, p) =>
      db.transaction(async (tx) => {
        const { rows } = await tx.query<{ acked_seq: string | number }>(
          `UPDATE uncage_hub_links
           SET acked_seq = LEAST(GREATEST(acked_seq, COALESCE($3::bigint, acked_seq)), next_seq), busy = COALESCE($4::boolean, busy), updated_at = $5
           WHERE machine_id = $1 AND link_id = $2 AND link_id <> '' RETURNING acked_seq`,
          [machineId, linkId, p.ackedSeq ?? null, p.busy ?? null, p.at],
        );
        if (!rows[0]) {
          const cur = await tx.query<{ link_id: string }>('SELECT link_id FROM uncage_hub_links WHERE machine_id = $1', [machineId]);
          return linkState(cur.rows[0], linkId);
        }
        if (p.ackedSeq !== undefined) {
          await tx.query('DELETE FROM uncage_hub_outbox WHERE machine_id = $1 AND seq <= $2', [machineId, rows[0].acked_seq]);
        }
        return 'current' as const;
      }),
    async closeLink(machineId, linkId) {
      await db.query(
        `UPDATE uncage_hub_links SET link_id = '', busy = false WHERE machine_id = $1 AND link_id <> '' AND ($2::text IS NULL OR link_id = $2)`,
        [machineId, linkId],
      );
    },
    async enqueueOutbox(machineId, items, createdAt) {
      if (items.length === 0) return [];
      return db.transaction(async (tx): Promise<number[] | 'gone'> => {
        // FOR SHARE: a concurrent deleteMachine waits for this commit (or wins first and we see no
        // machine), so a deleted machine never gets its link row back.
        const m = await tx.query('SELECT 1 FROM uncage_hub_machines WHERE id = $1 FOR SHARE', [machineId]);
        if (m.rows.length === 0) return 'gone';
        await tx.query(
          `INSERT INTO uncage_hub_links (machine_id, link_id, transport, updated_at) VALUES ($1, '', '', $2) ON CONFLICT (machine_id) DO NOTHING`,
          [machineId, createdAt],
        );
        // The row lock taken here is held until commit, so writers for one machine run one after
        // another: commit order is seq order and a reader never sees a gap that fills in later.
        const { rows } = await tx.query<{ next_seq: string | number }>(
          'UPDATE uncage_hub_links SET next_seq = next_seq + $2 WHERE machine_id = $1 RETURNING next_seq',
          [machineId, items.length],
        );
        const last = Number(rows[0]!.next_seq);
        const seqs = items.map((_, i) => last - items.length + 1 + i);
        const params: unknown[] = [machineId, createdAt];
        const values = items.map((it, i) => {
          params.push(seqs[i], it.msgId, json(it.msg), it.expiresAt);
          const b = params.length - 3;
          return `($1, $${b}, $${b + 1}, $${b + 2}::jsonb, $${b + 3}, $2)`;
        });
        await tx.query(
          `INSERT INTO uncage_hub_outbox (machine_id, seq, msg_id, msg, expires_at, created_at) VALUES ${values.join(', ')}`,
          params,
        );
        return seqs;
      });
    },

    async claimInbox(machineId, msgIds, o) {
      const out: Record<string, 'new' | 'done' | 'busy'> = {};
      for (const msgId of msgIds) {
        if (out[msgId]) {
          out[msgId] = out[msgId] === 'new' ? 'busy' : out[msgId];
          continue;
        }
        // Atomic per id: inserted, or taken over from a claim whose lease is over.
        const { rows } = await db.query(
          `INSERT INTO uncage_hub_inbox AS i (machine_id, msg_id, state, lease_until, updated_at) VALUES ($1, $2, 'processing', $3, $4)
           ON CONFLICT (machine_id, msg_id) DO UPDATE SET lease_until = EXCLUDED.lease_until, updated_at = EXCLUDED.updated_at
           WHERE i.state = 'processing' AND i.lease_until < EXCLUDED.updated_at
           RETURNING msg_id`,
          [machineId, msgId, o.leaseUntil, o.now],
        );
        if (rows.length > 0) {
          out[msgId] = 'new';
          continue;
        }
        const cur = await db.query<{ state: string }>('SELECT state FROM uncage_hub_inbox WHERE machine_id = $1 AND msg_id = $2', [machineId, msgId]);
        out[msgId] = cur.rows[0]?.state === 'done' ? 'done' : 'busy';
      }
      return out;
    },
    async completeInbox(machineId, msgIds, at) {
      if (msgIds.length === 0) return;
      await db.query(
        `INSERT INTO uncage_hub_inbox (machine_id, msg_id, state, lease_until, updated_at)
         SELECT $1, m, 'done', $3, $3 FROM unnest($2::text[]) AS m
         ON CONFLICT (machine_id, msg_id) DO UPDATE SET state = 'done', lease_until = EXCLUDED.lease_until, updated_at = EXCLUDED.updated_at`,
        [machineId, [...new Set(msgIds)], at],
      );
    },

    async hitRateLimit(key, o) {
      const windowStart = Math.floor(o.nowMs / o.windowMs) * o.windowMs;
      const { rows } = await db.query<{ count: number }>(
        `INSERT INTO uncage_hub_rate_limits AS r (key, window_start, count) VALUES ($1, $2, 1)
         ON CONFLICT (key, window_start) DO UPDATE SET count = r.count + 1 RETURNING count`,
        [key, windowStart],
      );
      if (Number(rows[0]!.count) <= o.max) return { allowed: true, retryAfterMs: 0 };
      // Over the limit: take the hit back so refused attempts do not push the count further.
      await db.query('UPDATE uncage_hub_rate_limits SET count = count - 1 WHERE key = $1 AND window_start = $2', [key, windowStart]);
      return { allowed: false, retryAfterMs: windowStart + o.windowMs - o.nowMs };
    },
    async releaseRateLimit(key, o) {
      const windowStart = Math.floor(o.nowMs / o.windowMs) * o.windowMs;
      await db.query('UPDATE uncage_hub_rate_limits SET count = count - 1 WHERE key = $1 AND window_start = $2 AND count > 0', [key, windowStart]);
    },
    async tryLease(name, o) {
      const { rows } = await db.query(
        `INSERT INTO uncage_hub_leases AS l (name, holder, until) VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, until = EXCLUDED.until
         WHERE l.holder = EXCLUDED.holder OR l.until < $4
         RETURNING name`,
        [name, o.holder, o.until, o.now],
      );
      return rows.length > 0;
    },
    async pruneTransport(o) {
      // Batched (short statements, no long-held locks on a big backlog); only counts come back.
      const prune = async (table: string, where: string, params: unknown[]): Promise<number> => {
        let total = 0;
        for (;;) {
          const { rows } = await db.query<{ n: number }>(
            `WITH d AS (DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${PRUNE_BATCH}) RETURNING 1)
             SELECT count(*)::int AS n FROM d`,
            params,
          );
          const n = Number(rows[0]?.n ?? 0);
          total += n;
          if (n < PRUNE_BATCH) return total;
        }
      };
      const [outbox, inbox, rateLimits, deviceCodes] = await Promise.all([
        prune('uncage_hub_outbox', 'expires_at < $1', [o.now]),
        prune('uncage_hub_inbox', `updated_at < $1 AND (state = 'done' OR lease_until < $2)`, [o.inboxBefore, o.now]),
        prune('uncage_hub_rate_limits', 'window_start < $1', [o.rateLimitBeforeMs]),
        prune('uncage_hub_device_codes', 'expires_at < $1', [new Date(Date.parse(o.now) - 3_600_000).toISOString()]),
      ]);
      return { outbox, inbox, rateLimits, deviceCodes };
    },

    close,
  };
}
