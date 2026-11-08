/**
 * The demo's asset store: one folder per asset under `<data dir>/assets/<id>/` with `meta.json`
 * and, once published, the page's files in `files/`. Plain files, so several demo nodes on one
 * machine (multi-node dev mode) and the Next.js pages all see the same assets without sharing
 * memory. A real site would use its database and object storage.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { dataDir } from './config.ts';

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

const ID = /^a_[A-Za-z0-9_-]{12}$/;
/** A page file path: relative, `/`-separated, no `.`/`..`/empty segments, no backslashes. */
const SAFE_PATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._ -]+(?:\/[A-Za-z0-9._ -]+)*$/;
export const MAX_FILES = 200;

const root = (): string => join(dataDir(), 'assets');
const metaPath = (id: string): string => join(root(), id, 'meta.json');

export const isAssetId = (id: string): boolean => ID.test(id);
export const isSafeAssetPath = (p: string): boolean => p.length <= 300 && SAFE_PATH.test(p);

async function writeMeta(a: Asset): Promise<void> {
  const file = metaPath(a.id);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(a, null, 2));
  await rename(tmp, file);
}

export async function createAsset(o: { owner: string; title: string; kind: AssetKind; sessionId: string }): Promise<Asset> {
  const asset: Asset = {
    id: `a_${randomBytes(9).toString('base64url')}`,
    owner: o.owner,
    title: o.title,
    kind: o.kind,
    status: 'draft',
    sessionId: o.sessionId,
    createdAt: new Date().toISOString(),
  };
  await writeMeta(asset);
  return asset;
}

export async function getAsset(id: string): Promise<Asset | null> {
  if (!isAssetId(id)) return null;
  try {
    return JSON.parse(await readFile(metaPath(id), 'utf8')) as Asset;
  } catch {
    return null;
  }
}

/** `owner`'s assets, newest first. */
export async function listAssets(owner: string): Promise<Asset[]> {
  const ids = await readdir(root()).catch(() => [] as string[]);
  const all = await Promise.all(ids.map(getAsset));
  return all
    .filter((a): a is Asset => a !== null && a.owner === owner)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Stores the page's files (replacing an earlier publish) and marks the asset published. Paths are
 * relative to the page root and must include `index.html`.
 */
export async function publishAsset(id: string, files: Array<{ path: string; data: Uint8Array }>): Promise<Asset> {
  const asset = await getAsset(id);
  if (!asset) throw new Error(`Unknown asset ${id}`);
  if (files.length === 0) throw new Error('The folder is empty.');
  if (files.length > MAX_FILES) throw new Error(`Too many files (${files.length}; at most ${MAX_FILES}).`);
  const bad = files.find((f) => !isSafeAssetPath(f.path));
  if (bad) throw new Error(`Unsupported file name: ${bad.path}`);
  if (!files.some((f) => f.path === 'index.html')) throw new Error('The folder has no index.html at its top level.');

  const dir = join(root(), id);
  const staging = join(dir, `files.${randomBytes(4).toString('hex')}.tmp`);
  const live = join(dir, 'files');
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
  const published: Asset = {
    ...asset,
    status: 'published',
    publishedAt: new Date().toISOString(),
    files: files.map((f) => ({ path: f.path, size: f.data.byteLength })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  await writeMeta(published);
  return published;
}

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

/** One file of a published asset, or null (unknown, unpublished, or a path outside the page). */
export async function readAssetFile(id: string, path: string): Promise<{ data: Buffer; contentType: string } | null> {
  const asset = await getAsset(id);
  if (!asset || asset.status !== 'published' || !isSafeAssetPath(path)) return null;
  if (!asset.files?.some((f) => f.path === path)) return null;
  const base = resolve(root(), id, 'files');
  const file = resolve(base, ...path.split('/'));
  if (!file.startsWith(base + sep)) return null;
  try {
    return { data: await readFile(file), contentType: TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
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

/** Deletes assets last created or published more than `maxAgeMs` ago (public demo housekeeping); returns how many. */
export async function purgeAssetsOlderThan(maxAgeMs: number, now: number = Date.now()): Promise<number> {
  const ids = await readdir(root()).catch(() => [] as string[]);
  let removed = 0;
  for (const id of ids) {
    if (!isAssetId(id)) continue;
    const asset = await getAsset(id);
    // Age counts from the later of creation and the last publish.
    const created = asset ? Math.max(Date.parse(asset.createdAt), Date.parse(asset.publishedAt ?? asset.createdAt)) : Number.NaN;
    // An unreadable or unparsable meta.json is junk: remove it too.
    if (Number.isFinite(created) && now - created <= maxAgeMs) continue;
    await rm(join(root(), id), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
