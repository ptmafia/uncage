/**
 * The users' Expo push tokens (what `expoPushNotifier`'s `tokensFor` reads; the hub never stores
 * them). Two back ends, picked like the asset store (lib/assets.ts):
 *
 * - `filePushTokenStore(dir)`: one JSON file per user. Traditional mode without a database.
 * - `postgresPushTokenStore(pool)`: table `demo_push_tokens`, created on first use. FaaS mode, or
 *   whenever `DATABASE_URL` is set.
 *
 * A token belongs to one user at a time (the device's latest sign-in), and a user keeps at most
 * `MAX_PUSH_TOKENS_PER_USER` (the oldest go). Tokens not re-registered for `PUSH_TOKEN_MAX_AGE_MS`
 * are purged by the demo's housekeeping (lib/hub.ts).
 *
 * Trade-off: whoever knows a device's Expo push token can register it to their own account, which
 * stops the previous user's pushes to that device (and sends the new account's to it). Keeping it
 * with the old user instead would leak one user's notifications to whoever uses the device now.
 * Expo tokens are semi-secret (only the app on the device learns it); treat them like that.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PgPoolLike } from '@uncage/hub';
import { dataDir } from './config.ts';
import { sharedPool } from './db.ts';

export const MAX_PUSH_TOKENS_PER_USER = 10;
/** The app re-registers its token on every launch; one unseen this long is dropped (housekeeping). */
export const PUSH_TOKEN_MAX_AGE_MS = 30 * 24 * 3600_000;

const EXPO_TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/;

/** An `expo-notifications` push token: `ExponentPushToken[…]` (or the newer `ExpoPushToken[…]`). */
export function isExpoPushToken(token: unknown): token is string {
  return typeof token === 'string' && EXPO_TOKEN.test(token);
}

export interface PushTokenStore {
  /** Registers `token` for `user` (as their newest), taking it away from any other user. */
  add(user: string, token: string): Promise<void>;
  /** `user`'s tokens. */
  list(user: string): Promise<string[]>;
  /** Forgets `token` (only if it is `user`'s, when given). */
  remove(token: string, user?: string): Promise<void>;
  /** Deletes tokens last registered more than `maxAgeMs` ago; returns how many. */
  purgeOlderThan(maxAgeMs: number, now?: number): Promise<number>;
}

/** "Users" whose file can exist (the demo's usernames). */
const USER_FILE = /^[a-z0-9][a-z0-9_-]{0,31}\.json$/;
const USER = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Push tokens as files: `<dir>/users/<user>.json` (`[{ token, at }]`, newest last) and a reverse
 * index `<dir>/by-token/<sha256(token)>` holding the owner's name, so registering or removing a token
 * reads one or two files however many users there are. Only the hourly purge walks every user.
 */
export function filePushTokenStore(dir: string): PushTokenStore {
  type Entry = { token: string; at: number };
  const usersDir = join(dir, 'users');
  const indexDir = join(dir, 'by-token');
  const userFile = (user: string) => join(usersDir, `${user}.json`);
  const indexFile = (token: string) => join(indexDir, createHash('sha256').update(token).digest('hex'));
  const atomicWrite = async (file: string, data: string, parent: string): Promise<void> => {
    await mkdir(parent, { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  };
  const read = async (user: string): Promise<Entry[]> => {
    try {
      const v = JSON.parse(await readFile(userFile(user), 'utf8')) as unknown;
      return Array.isArray(v) ? (v as Entry[]).filter((e) => isExpoPushToken(e?.token) && Number.isFinite(e.at)) : [];
    } catch {
      return [];
    }
  };
  const write = async (user: string, entries: Entry[]): Promise<void> => {
    if (entries.length === 0) await rm(userFile(user), { force: true });
    else await atomicWrite(userFile(user), JSON.stringify(entries), usersDir);
  };
  const owner = async (token: string): Promise<string | null> => {
    const name = (await readFile(indexFile(token), 'utf8').catch(() => '')).trim();
    return USER.test(name) ? name : null;
  };
  const unindex = (tokens: string[]) => Promise.all(tokens.map((t) => rm(indexFile(t), { force: true })));
  /** Drops `token` from `user`'s file (the index is the caller's business). */
  const dropFrom = async (user: string, token: string): Promise<void> => {
    const entries = await read(user);
    const kept = entries.filter((e) => e.token !== token);
    if (kept.length !== entries.length) await write(user, kept);
  };
  return {
    async add(user, token) {
      const prev = await owner(token);
      if (prev && prev !== user) await dropFrom(prev, token);
      const entries = (await read(user)).filter((e) => e.token !== token);
      entries.push({ token, at: Date.now() });
      const kept = entries.slice(-MAX_PUSH_TOKENS_PER_USER);
      await write(user, kept);
      await atomicWrite(indexFile(token), user, indexDir);
      await unindex(entries.slice(0, entries.length - kept.length).map((e) => e.token));
    },
    async list(user) {
      return (await read(user)).map((e) => e.token);
    },
    async remove(token, user) {
      const current = await owner(token);
      if (!current || (user && user !== current)) return;
      await dropFrom(current, token);
      await unindex([token]);
    },
    async purgeOlderThan(maxAgeMs, now = Date.now()) {
      const files = (await readdir(usersDir).catch(() => [] as string[])).filter((f) => USER_FILE.test(f));
      let removed = 0;
      for (const f of files) {
        const user = f.slice(0, -5);
        const entries = await read(user);
        const stale = entries.filter((e) => now - e.at > maxAgeMs);
        if (stale.length === 0) continue;
        await write(user, entries.filter((e) => now - e.at <= maxAgeMs));
        // Only index entries still pointing at this user (the token may have moved since).
        for (const e of stale) if ((await owner(e.token)) === user) await unindex([e.token]);
        removed += stale.length;
      }
      return removed;
    },
  };
}

/** "push" in ASCII: serializes the CREATE TABLE of instances starting at once, and per-user adds. */
const LOCK = 0x70757368;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS demo_push_tokens (
    token text PRIMARY KEY,
    user_id text NOT NULL,
    seq bigserial NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  'CREATE INDEX IF NOT EXISTS demo_push_tokens_user ON demo_push_tokens (user_id, seq DESC)',
];

/** Push tokens in Postgres (`pg.Pool`, or anything with its `query` / `connect` shape). The pool stays yours. */
export function postgresPushTokenStore(pool: PgPoolLike): PushTokenStore {
  type Q = (sql: string, params?: unknown[]) => Promise<unknown[]>;
  const transaction = async (fn: (q: Q) => Promise<void>): Promise<void> => {
    const client = await pool.connect();
    const q: Q = async (sql, params = []) => (await client.query(sql, params)).rows as unknown[];
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      try {
        await fn(q);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch((re: unknown) => (broken = re instanceof Error ? re : new Error(String(re))));
        throw e;
      }
    } finally {
      client.release(broken);
    }
  };
  let ready: Promise<void> | undefined;
  const ensure = (): Promise<void> => {
    if (!ready) {
      const p = transaction(async (q) => {
        await q('SELECT pg_advisory_xact_lock($1)', [LOCK]);
        for (const stmt of SCHEMA) await q(stmt);
      });
      ready = p;
      p.catch(() => {
        if (ready === p) ready = undefined;
      });
    }
    return ready;
  };
  return {
    async add(user, token) {
      await ensure();
      await transaction(async (q) => {
        // Per-user lock: concurrent registrations of one user never leave more than the cap.
        await q('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK, user]);
        await q(
          `INSERT INTO demo_push_tokens (token, user_id) VALUES ($1, $2)
           ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, created_at = now(),
             seq = nextval(pg_get_serial_sequence('demo_push_tokens', 'seq'))`,
          [token, user],
        );
        await q(
          `DELETE FROM demo_push_tokens WHERE user_id = $1 AND token NOT IN (
             SELECT token FROM demo_push_tokens WHERE user_id = $1 ORDER BY seq DESC LIMIT $2)`,
          [user, MAX_PUSH_TOKENS_PER_USER],
        );
      });
    },
    async list(user) {
      await ensure();
      const rows = (await pool.query('SELECT token FROM demo_push_tokens WHERE user_id = $1 ORDER BY seq', [user])).rows as Array<{ token: string }>;
      return rows.map((r) => r.token);
    },
    async remove(token, user) {
      await ensure();
      if (user) await pool.query('DELETE FROM demo_push_tokens WHERE token = $1 AND user_id = $2', [token, user]);
      else await pool.query('DELETE FROM demo_push_tokens WHERE token = $1', [token]);
    },
    async purgeOlderThan(maxAgeMs, now = Date.now()) {
      await ensure();
      const cutoff = new Date(now - maxAgeMs).toISOString();
      return (await pool.query('DELETE FROM demo_push_tokens WHERE created_at < $1::timestamptz RETURNING token', [cutoff])).rows.length;
    },
  };
}

const STORES = Symbol.for('uncage.connected-demo.push-token-stores');

/**
 * This process's push token store: Postgres when `DATABASE_URL` is set (on the shared pool,
 * lib/db.ts), otherwise files under `<data dir>/push-tokens`.
 */
export function pushTokenStore(env: Record<string, string | undefined> = process.env): PushTokenStore {
  const url = env.DATABASE_URL?.trim();
  if (!url) return filePushTokenStore(join(dataDir(env), 'push-tokens'));
  const pool = sharedPool(url, env);
  const g = globalThis as Record<symbol, WeakMap<object, PushTokenStore> | undefined>;
  const stores = (g[STORES] ??= new WeakMap());
  let store = stores.get(pool);
  if (!store) {
    store = postgresPushTokenStore(pool);
    stores.set(pool, store);
  }
  return store;
}
