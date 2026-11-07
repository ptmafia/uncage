import type { Attachment, RuntimeInfo, UncageEvent } from '@uncage/protocol';
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
];

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
});

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
      const { rows } = await db.query('DELETE FROM uncage_hub_machines WHERE id = $1 RETURNING id', [id]);
      return rows.length > 0;
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

    async insertSession(r) {
      await db.query(
        `INSERT INTO uncage_hub_sessions (id, user_id, machine_id, created_at, title, active_run, last_sequence, snapshot)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb) ON CONFLICT (id) DO NOTHING`,
        [
          r.id,
          r.userId,
          r.machineId,
          r.createdAt,
          r.title,
          r.activeRun ? json(r.activeRun) : null,
          r.lastSequence,
          r.snapshot ? json(r.snapshot) : null,
        ],
      );
      const stored = await one('SELECT * FROM uncage_hub_sessions WHERE id = $1', [r.id], toSession);
      if (!stored) throw new Error(`session ${r.id} vanished after insert`);
      return stored;
    },
    getSession: (id) => one('SELECT * FROM uncage_hub_sessions WHERE id = $1', [id], toSession),
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
        'INSERT INTO uncage_hub_attachments (id, user_id, meta, data) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT DO NOTHING',
        [r.attachment.id, r.userId, json(r.attachment), r.data],
      );
    },
    getAttachment: (id) =>
      one<{ user_id: string; meta: Attachment; data: Uint8Array }, AttachmentRecord>(
        'SELECT user_id, meta, data FROM uncage_hub_attachments WHERE id = $1',
        [id],
        (r) => ({ attachment: r.meta, userId: r.user_id, data: new Uint8Array(r.data) }),
      ),

    close,
  };
}
