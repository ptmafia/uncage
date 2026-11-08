/**
 * The demo's asset store, behind one interface with two back ends:
 *
 * - `fileAssetStore(dir)`: one folder per asset (`<dir>/<id>/meta.json` and, once published, the
 *   page's files in `files/`). Plain files, so several demo nodes on one machine and the Next.js
 *   pages all see the same assets without sharing memory. Traditional mode without a database.
 * - `postgresAssetStore(pool)`: tables `demo_assets` and `demo_asset_files` (file bytes as `bytea`),
 *   created on first use. Required in FaaS mode (Vercel has no persistent disk), used whenever
 *   `DATABASE_URL` is set.
 *
 * `assetStore()` picks one. A real site would use its database and object storage.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import type { PgPoolLike } from '@uncage/hub';
import { dataDir } from './config.ts';
import { sharedPool } from './db.ts';

export type AssetKind = 'landing-page';

export interface Asset {
  id: string;
  owner: string;
  title: string;
  kind: AssetKind;
  status: 'draft' | 'published';
  /** The Uncage session (conversation) that made it. */
  sessionId: string;
  createdAt: string;
  publishedAt?: string;
  /** Published files, relative to the page root (`index.html` is the entry). */
  files?: Array<{ path: string; size: number }>;
}

/** `create` refused: the owner already keeps `limit` assets. */
export class AssetQuotaError extends Error {
  // A plain field, not a parameter property: server.ts runs under Node's strip-only TypeScript.
  readonly limit: number;
  constructor(limit: number) {
    super(
      `This demo keeps at most ${limit} assets per visitor, and you already have that many. Publish into one of your existing assets instead (publish_asset replaces its files), or try again after older ones are cleared (24 hours after they were last created or published).`,
    );
    this.limit = limit;
    this.name = 'AssetQuotaError';
  }
}

export interface AssetStore {
  /**
   * With `maxPerOwner`, refuses (AssetQuotaError) when the owner already keeps that many. Postgres
   * counts and inserts under a per-owner lock, so concurrent creates never pass the limit; the file
   * store checks best-effort.
   */
  create(o: { owner: string; title: string; kind: AssetKind; sessionId: string }, limits?: { maxPerOwner?: number }): Promise<Asset>;
  get(id: string): Promise<Asset | null>;
  /** `owner`'s assets, newest first. */
  list(owner: string): Promise<Asset[]>;
  count(owner: string): Promise<number>;
  /**
   * Stores the page's files (replacing an earlier publish) and marks the asset published. Paths are
   * relative to the page root and must include `index.html`.
   */
  publish(id: string, files: Array<{ path: string; data: Uint8Array }>): Promise<Asset>;
  /** One file of a published asset, or null (unknown, unpublished, or a path outside the page). */
  readFile(id: string, path: string): Promise<{ data: Uint8Array; contentType: string } | null>;
  /** Deletes assets last created or published more than `maxAgeMs` ago (public demo housekeeping); returns how many. */
  purgeOlderThan(maxAgeMs: number, now?: number): Promise<number>;
}

const ID = /^a_[A-Za-z0-9_-]{12}$/;
/** A page file path: relative, `/`-separated, no `.`/`..`/empty segments, no backslashes. */
const SAFE_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*$/;
export const MAX_FILES = 200;

export const isAssetId = (id: string): boolean => ID.test(id);
export const isSafeAssetPath = (p: string): boolean => p.length <= 300 && SAFE_PATH.test(p);

const newAsset = (o: { owner: string; title: string; kind: AssetKind; sessionId: string }): Asset => ({
  id: `a_${randomBytes(9).toString('base64url')}`,
  owner: o.owner,
  title: o.title,
  kind: o.kind,
  status: 'draft',
  sessionId: o.sessionId,
  createdAt: new Date().toISOString(),
});

/** The same refusals in every store, before anything is written. */
function checkPublish(files: Array<{ path: string; data: Uint8Array }>): void {
  if (files.length === 0) throw new Error('The folder is empty.');
  if (files.length > MAX_FILES) throw new Error(`Too many files (${files.length}; at most ${MAX_FILES}).`);
  const bad = files.find((f) => !isSafeAssetPath(f.path));
  if (bad) throw new Error(`Unsupported file name: ${bad.path}`);
  if (!files.some((f) => f.path === 'index.html')) throw new Error('The folder has no index.html at its top level.');
}

const published = (asset: Asset, files: Array<{ path: string; data: Uint8Array }>): Asset => ({
  ...asset,
  status: 'published',
  publishedAt: new Date().toISOString(),
  files: files.map((f) => ({ path: f.path, size: f.data.byteLength })).sort((a, b) => a.path.localeCompare(b.path)),
});

/** Whether `path` is one of the published asset's files. */
const servable = (asset: Asset | null, path: string): asset is Asset =>
  !!asset && asset.status === 'published' && isSafeAssetPath(path) && !!asset.files?.some((f) => f.path === path);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};
const contentType = (path: string): string => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

/** Age counts from the later of creation and the last publish; NaN when unparsable. */
const lastTouched = (a: Asset): number => Math.max(Date.parse(a.createdAt), Date.parse(a.publishedAt ?? a.createdAt));

/** Assets as folders under `dir`. */
export function fileAssetStore(dir: string): AssetStore {
  const metaPath = (id: string): string => join(dir, id, 'meta.json');
  async function writeMeta(a: Asset): Promise<void> {
    const file = metaPath(a.id);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(a, null, 2));
    await rename(tmp, file);
  }
  const store: AssetStore = {
    async create(o, limits) {
      if (limits?.maxPerOwner !== undefined && (await store.count(o.owner)) >= limits.maxPerOwner) throw new AssetQuotaError(limits.maxPerOwner);
      const asset = newAsset(o);
      await writeMeta(asset);
      return asset;
    },
    async get(id) {
      if (!isAssetId(id)) return null;
      try {
        return JSON.parse(await readFile(metaPath(id), 'utf8')) as Asset;
      } catch {
        return null;
      }
    },
    async list(owner) {
      const ids = await readdir(dir).catch(() => [] as string[]);
      const all = await Promise.all(ids.map((id) => store.get(id)));
      return all.filter((a): a is Asset => a !== null && a.owner === owner).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async count(owner) {
      return (await store.list(owner)).length;
    },
    async publish(id, files) {
      const asset = await store.get(id);
      if (!asset) throw new Error(`Unknown asset ${id}`);
      checkPublish(files);
      const base = join(dir, id);
      const staging = join(base, `files.${randomBytes(4).toString('hex')}.tmp`);
      const live = join(base, 'files');
      try {
        for (const f of files) {
          const target = join(staging, ...f.path.split('/'));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, f.data);
        }
        await rm(live, { recursive: true, force: true });
        await rename(staging, live);
      } catch (e) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw e;
      }
      const next = published(asset, files);
      await writeMeta(next);
      return next;
    },
    async readFile(id, path) {
      const asset = await store.get(id);
      if (!servable(asset, path)) return null;
      const base = resolve(dir, id, 'files');
      const file = resolve(base, ...path.split('/'));
      if (!file.startsWith(base + sep)) return null;
      try {
        return { data: await readFile(file), contentType: contentType(file) };
      } catch {
        return null;
      }
    },
    async purgeOlderThan(maxAgeMs, now = Date.now()) {
      const ids = await readdir(dir).catch(() => [] as string[]);
      let removed = 0;
      for (const id of ids) {
        if (!isAssetId(id)) continue;
        const asset = await store.get(id);
        const touched = asset ? lastTouched(asset) : Number.NaN;
        // An unreadable or unparsable meta.json is junk: remove it too.
        if (Number.isFinite(touched) && now - touched <= maxAgeMs) continue;
        await rm(join(dir, id), { recursive: true, force: true });
        removed += 1;
      }
      return removed;
    },
  };
  return store;
}

interface AssetRow {
  id: string;
  owner: string;
  title: string;
  kind: string;
  status: string;
  session_id: string;
  created_at: string;
  published_at: string | null;
  files: Array<{ path: string; size: number }> | string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS demo_assets (
  id text PRIMARY KEY,
  owner text NOT NULL,
  title text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  session_id text NOT NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  files jsonb
);
CREATE INDEX IF NOT EXISTS demo_assets_owner ON demo_assets (owner, created_at DESC);
CREATE TABLE IF NOT EXISTS demo_asset_files (
  asset_id text NOT NULL REFERENCES demo_assets (id) ON DELETE CASCADE,
  path text NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (asset_id, path)
);`;
/** "demo" in ASCII: serializes the CREATE TABLEs of instances starting at once. */
const SCHEMA_LOCK = 0x64656d6f;
const COLUMNS = `id, owner, title, kind, status, session_id,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at, files`;

const fromRow = (r: AssetRow): Asset => {
  const files = typeof r.files === 'string' ? (JSON.parse(r.files) as Asset['files']) : r.files;
  return {
    id: r.id,
    owner: r.owner,
    title: r.title,
    kind: r.kind as AssetKind,
    status: r.status as Asset['status'],
    sessionId: r.session_id,
    createdAt: r.created_at,
    ...(r.published_at ? { publishedAt: r.published_at } : {}),
    ...(files ? { files } : {}),
  };
};

/** Assets in Postgres (`pg.Pool`, or anything with its `query` / `connect` shape). The pool stays yours. */
export function postgresAssetStore(pool: PgPoolLike): AssetStore {
  let ready: Promise<void> | undefined;
  const ensure = (): Promise<void> => {
    if (!ready) {
      const p = (async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          try {
            await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
            for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await client.query(stmt);
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw e;
          }
        } finally {
          client.release();
        }
      })();
      ready = p;
      p.catch(() => {
        if (ready === p) ready = undefined;
      });
    }
    return ready;
  };
  type Q = <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
  /** Runs `fn` in one transaction on one checked-out connection (call `ensure()` first). */
  const inTransaction = async (fn: (q: Q) => Promise<void>): Promise<void> => {
    const client = await pool.connect();
    const q: Q = async <T,>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[];
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
  const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    await ensure();
    return (await pool.query(sql, params)).rows as T[];
  };

  const store: AssetStore = {
    async create(o, limits) {
      const a = newAsset(o);
      await ensure();
      await inTransaction(async (q) => {
        if (limits?.maxPerOwner !== undefined) {
          // Per-owner lock: concurrent creates of one guest count and insert one after another.
          await q('SELECT pg_advisory_xact_lock($1, hashtext($2))', [SCHEMA_LOCK, o.owner]);
          const [row] = await q<{ n: number | string }>('SELECT count(*)::int AS n FROM demo_assets WHERE owner = $1', [o.owner]);
          if (Number(row?.n ?? 0) >= limits.maxPerOwner) throw new AssetQuotaError(limits.maxPerOwner);
        }
        await q('INSERT INTO demo_assets (id, owner, title, kind, status, session_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)', [
          a.id,
          a.owner,
          a.title,
          a.kind,
          a.status,
          a.sessionId,
          a.createdAt,
        ]);
      });
      return a;
    },
    async get(id) {
      if (!isAssetId(id)) return null;
      const [row] = await query<AssetRow>(`SELECT ${COLUMNS} FROM demo_assets WHERE id = $1`, [id]);
      return row ? fromRow(row) : null;
    },
    async list(owner) {
      return (await query<AssetRow>(`SELECT ${COLUMNS} FROM demo_assets WHERE owner = $1 ORDER BY created_at DESC, id`, [owner])).map(fromRow);
    },
    async count(owner) {
      const [row] = await query<{ n: number | string }>('SELECT count(*)::int AS n FROM demo_assets WHERE owner = $1', [owner]);
      return Number(row?.n ?? 0);
    },
    async publish(id, files) {
      const asset = await store.get(id);
      if (!asset) throw new Error(`Unknown asset ${id}`);
      checkPublish(files);
      const next = published(asset, files);
      // One transaction: readers see the old files or the new ones, never a mix.
      await inTransaction(async (q) => {
        await q('DELETE FROM demo_asset_files WHERE asset_id = $1', [id]);
        for (const f of files) {
          await q('INSERT INTO demo_asset_files (asset_id, path, data) VALUES ($1, $2, $3)', [id, f.path, Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength)]);
        }
        const updated = await q("UPDATE demo_assets SET status = 'published', published_at = $2::timestamptz, files = $3::jsonb WHERE id = $1 RETURNING id", [
          id,
          next.publishedAt,
          JSON.stringify(next.files),
        ]);
        if (updated.length === 0) throw new Error(`Unknown asset ${id}`);
      });
      return next;
    },
    async readFile(id, path) {
      const asset = await store.get(id);
      if (!servable(asset, path)) return null;
      const [row] = await query<{ data: Uint8Array }>('SELECT data FROM demo_asset_files WHERE asset_id = $1 AND path = $2', [id, path]);
      return row ? { data: new Uint8Array(row.data.buffer, row.data.byteOffset, row.data.byteLength), contentType: contentType(path) } : null;
    },
    async purgeOlderThan(maxAgeMs, now = Date.now()) {
      const cutoff = new Date(now - maxAgeMs).toISOString();
      // Files go with their asset (ON DELETE CASCADE).
      const rows = await query('DELETE FROM demo_assets WHERE greatest(created_at, coalesce(published_at, created_at)) < $1::timestamptz RETURNING id', [cutoff]);
      return rows.length;
    },
  };
  return store;
}

const ASSET_STORES = Symbol.for('uncage.connected-demo.asset-stores');

/**
 * This process's asset store: Postgres when `DATABASE_URL` is set (on the process's shared pool,
 * lib/db.ts), otherwise files under `<data dir>/assets`.
 */
export function assetStore(env: Record<string, string | undefined> = process.env): AssetStore {
  const url = env.DATABASE_URL?.trim();
  if (!url) return fileAssetStore(join(dataDir(env), 'assets'));
  const pool = sharedPool(url, env);
  // One store per pool (its schema check runs once); a pool ended by the hub's close gets a new store.
  const g = globalThis as Record<symbol, WeakMap<object, AssetStore> | undefined>;
  const stores = (g[ASSET_STORES] ??= new WeakMap());
  let store = stores.get(pool);
  if (!store) {
    store = postgresAssetStore(pool);
    stores.set(pool, store);
  }
  return store;
}

/**
 * Whether `viewer` may read a published asset's files. Drafts are never readable. In public demo
 * mode only the owner may, since guests share one origin and must not see each other's pages.
 */
export function canReadAsset(asset: Asset, viewer: string | null, publicMode: boolean): boolean {
  if (asset.status !== 'published') return false;
  return publicMode ? viewer !== null && viewer === asset.owner : true;
}

/**
 * Whether a request to /asset-files must pass the owner check, judged by its `Sec-Fetch-Dest`.
 * Sub-resources (style, script, image...) come from the opaque-origin sandboxed iframe and do not
 * carry the Lax session cookie, so they are not checked: the unguessable asset id guards them.
 * Requests that open a file as a page are always checked. So is a `fetch()`-style request
 * (`empty`) that does carry a signed-in user who is not the owner: a cookieless one is a
 * sub-resource of the sandboxed page, a signed-in non-owner is another guest reading the file.
 */
export function needsOwnerCheck(dest: string | null, viewer: string | null = null, owner?: string): boolean {
  if (dest === 'empty') return viewer !== null && viewer !== owner;
  return dest === null || ['document', 'iframe', 'frame', 'embed', 'object'].includes(dest);
}
