import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@uncage/hub';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetCsp } from './asset-csp.ts';
import { PGlite } from '@electric-sql/pglite';
import type { PgPoolLike } from '@uncage/hub';
import { AssetQuotaError, AssetStorageFullError, assetStore, canReadAsset, fileAssetStore, needsOwnerCheck, postgresAssetStore, type AssetStore } from './assets.ts';
import { guestUsername, normalizeUsername, readCookie, secret, signUser, verifyUser } from './auth.ts';
import { DEFAULT_MAX_TOTAL_MB, docsUrl, isPublicDemo, maxTotalBytes, publicUrl } from './config.ts';
import { isSameOrigin } from './csrf.ts';
import { clientIpResolver, createDemoHub, forwardedClient } from './hub.ts';
import { getHub, publishHub } from './hub-registry.ts';
import { demoMode, FAAS_ATTACHMENT_MAX_BYTES, faasAttachmentLimit, PUBLISHED_HUB_KEY, requireFaasEnv } from './mode.ts';
import { safeNext } from './session-utils.ts';
import { DEFAULT_DOCS_URL, landingPageSkill, makeLandingPageSkill } from './skills.ts';
import { createAssetTool, FAAS_PUBLISH_MAX_BYTES, pageRelative, PUBLIC_MAX_ASSETS_PER_OWNER, PUBLISH_MAX_BYTES, publishAssetTool, publishMaxBytes } from './tools.ts';
import { endSharedPool, sharedPool } from './db.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'connected-demo-'));
  process.env.DEMO_DATA_DIR = dir;
});
afterEach(async () => {
  delete process.env.DEMO_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b);
/** The store the app uses here: files under DEMO_DATA_DIR (no DATABASE_URL in tests). */
const assets = (): AssetStore => assetStore();

describe('demo cookie sign-in', () => {
  const key = Buffer.from('k'.repeat(32));
  it('signs and verifies a username; rejects tampering and bad names', () => {
    const v = signUser('alice', key);
    expect(verifyUser(v, key)).toBe('alice');
    expect(verifyUser(v.replace('alice', 'bob'), key)).toBeNull();
    expect(verifyUser(`${v}x`, key)).toBeNull();
    expect(verifyUser(signUser('alice', Buffer.from('other')), key)).toBeNull();
    expect(verifyUser(undefined, key)).toBeNull();
    expect(normalizeUsername(' Alice ')).toBe('alice');
    expect(normalizeUsername('a/b')).toBeNull();
    expect(normalizeUsername('')).toBeNull();
  });
  it('uses DEMO_SECRET only when it has at least 32 bytes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const strong = 's'.repeat(32);
    expect(secret({ ...process.env, DEMO_SECRET: strong, DEMO_DATA_DIR: dir }, 'traditional').toString()).toBe(strong);
    expect(warn).not.toHaveBeenCalled();
    const weak = secret({ ...process.env, DEMO_SECRET: 'short', DEMO_DATA_DIR: dir }, 'traditional');
    expect(weak.toString()).not.toBe('short');
    expect(weak.length).toBe(32); // the generated one
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/DEMO_SECRET/));
    warn.mockRestore();
  });

  it('reads a cookie from a header', () => {
    expect(readCookie('a=1; demo_user=x.y; b=2')).toBe('x.y');
    expect(readCookie(null)).toBeUndefined();
  });
  it('accepts only same-site POSTs and local redirect targets', () => {
    const req = (h: Record<string, string>) => new Request('http://localhost:3200/auth/login', { method: 'POST', headers: h });
    expect(isSameOrigin(req({ host: 'localhost:3200', origin: 'http://localhost:3200' }))).toBe(true);
    expect(isSameOrigin(req({ host: 'localhost:3200', origin: 'https://evil.example' }))).toBe(false);
    expect(isSameOrigin(req({ host: 'localhost:3200' }))).toBe(false);
    expect(safeNext('/assets')).toBe('/assets');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
  });
  it('uses the rightmost X-Forwarded-For entry behind the dev proxy', () => {
    expect(forwardedClient(new Request('http://x/', { headers: { 'x-forwarded-for': '1.1.1.1, 10.0.0.2' } }))).toBe('10.0.0.2');
    expect(forwardedClient(new Request('http://x/'))).toBeUndefined();
  });
  it('picks the rate-limit client IP from CLIENT_IP_HEADER, then TRUST_PROXY, else the socket', () => {
    const req = new Request('http://x/', { headers: { 'x-forwarded-for': '1.1.1.1, 10.0.0.2', 'x-real-ip': ' 203.0.113.7 ' } });
    expect(clientIpResolver({})).toBeUndefined();
    expect(clientIpResolver({ TRUST_PROXY: '0' })).toBeUndefined();
    expect(clientIpResolver({ TRUST_PROXY: '1' })?.(req)).toBe('10.0.0.2');
    expect(clientIpResolver({ CLIENT_IP_HEADER: 'X-Real-IP', TRUST_PROXY: '1' })?.(req)).toBe('203.0.113.7');
    expect(clientIpResolver({ CLIENT_IP_HEADER: 'cf-connecting-ip' })?.(req)).toBeUndefined();
    expect(clientIpResolver({ CLIENT_IP_HEADER: ' ' })).toBeUndefined();
  });
});

describe('public demo settings', () => {
  it('hands out random guest names that are valid usernames and never repeat', () => {
    const names = new Set(Array.from({ length: 200 }, () => guestUsername()));
    expect(names.size).toBe(200);
    for (const n of names) {
      expect(n).toMatch(/^guest-[a-z2-7]{12}$/);
      expect(normalizeUsername(n)).toBe(n);
    }
  });
  it('turns public mode on only with DEMO_PUBLIC=1', () => {
    expect(isPublicDemo({})).toBe(false);
    expect(isPublicDemo({ DEMO_PUBLIC: '1' })).toBe(true);
    expect(isPublicDemo({ DEMO_PUBLIC: 'true' })).toBe(false);
  });
  it('derives the public URL from PUBLIC_URL, then Railway, then Render, then localhost', () => {
    expect(publicUrl({ PUBLIC_URL: 'https://demo.example/', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' })).toBe('https://demo.example');
    expect(publicUrl({ RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' })).toBe('https://x.up.railway.app');
    expect(publicUrl({ RENDER_EXTERNAL_URL: 'https://x.onrender.com/' })).toBe('https://x.onrender.com');
    expect(publicUrl({ PORT: '4000' })).toBe('http://localhost:4000');
    // Vercel: the production domain when PUBLIC_URL is not set (never localhost).
    expect(publicUrl({ VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'demo.vercel.app' })).toBe('https://demo.vercel.app');
    expect(publicUrl({ VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'demo.vercel.app', PUBLIC_URL: 'https://demo.example' })).toBe('https://demo.example');
    expect(publicUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'demo.vercel.app', PORT: '1' })).toBe('http://localhost:1');
    expect(maxTotalBytes({})).toBe(DEFAULT_MAX_TOTAL_MB * 1024 * 1024);
    expect(DEFAULT_MAX_TOTAL_MB).toBe(200);
    expect(maxTotalBytes({ DEMO_MAX_TOTAL_MB: '50' })).toBe(50 * 1024 * 1024);
    expect(maxTotalBytes({ DEMO_MAX_TOTAL_MB: 'lots' })).toBe(200 * 1024 * 1024);
  });
});

describe('asset store', () => {
  it('creates, lists per owner, publishes and serves only published files inside the page', async () => {
    const a = await assets().create({ owner: 'alice', title: 'Uncage', kind: 'landing-page', sessionId: 's1' });
    await assets().create({ owner: 'bob', title: 'Other', kind: 'landing-page', sessionId: 's2' });
    expect((await assets().list('alice')).map((x) => x.id)).toEqual([a.id]);
    expect(await assets().readFile(a.id, 'index.html')).toBeNull(); // draft

    await assets().publish(a.id, [
      { path: 'index.html', data: enc('<h1>Uncage</h1>') },
      { path: 'css/app.css', data: enc('h1{}') },
    ]);
    const got = await assets().get(a.id);
    expect(got?.status).toBe('published');
    expect(got?.files?.map((f) => f.path)).toEqual(['css/app.css', 'index.html']);
    const file = await assets().readFile(a.id, 'index.html');
    expect(file?.contentType).toBe('text/html; charset=utf-8');
    expect(dec(file?.data)).toBe('<h1>Uncage</h1>');
    expect(await assets().readFile(a.id, '../meta.json')).toBeNull();
    expect(await assets().readFile(a.id, 'missing.html')).toBeNull();
    expect(await assets().get('../../etc')).toBeNull();
  });

  it('removes the staging dir when a publish fails part-way', async () => {
    const a = await assets().create({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    // "index.html" as a file and as a directory: the second write fails after staging was created.
    await expect(
      assets().publish(a.id, [
        { path: 'index.html', data: enc('x') },
        { path: 'index.html/x.css', data: enc('x') },
      ]),
    ).rejects.toThrow();
    expect((await readdir(join(dir, 'assets', a.id))).sort()).toEqual(['meta.json']);
    expect((await assets().get(a.id))?.status).toBe('draft');
  });

  it('refuses a publish without index.html or with unsafe paths', async () => {
    const a = await assets().create({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    await expect(assets().publish(a.id, [{ path: 'page.html', data: enc('x') }])).rejects.toThrow(/index\.html/);
    await expect(assets().publish(a.id, [{ path: 'index.html', data: enc('x') }, { path: '../x', data: enc('x') }])).rejects.toThrow(/Unsupported/);
    await expect(assets().publish(a.id, [])).rejects.toThrow(/empty/);
    expect((await assets().get(a.id))?.status).toBe('draft');
  });
});

function ctx(user: string, files: Record<string, string>, sessionId = 'sess_1'): ToolContext & { pulled: string[] } {
  const pulled: string[] = [];
  return {
    pulled,
    user: { id: user },
    sessionId,
    runId: 'run_1',
    signal: new AbortController().signal,
    files: {
      pull(path: string) {
        pulled.push(path);
        const entries = Object.entries(files).filter(([p]) => p === path || p.startsWith(`${path}/`));
        return {
          skipped: [],
          async *[Symbol.asyncIterator]() {
            for (const [p, text] of entries) yield { path: p, data: enc(text) };
          },
        };
      },
      read: () => Promise.reject(new Error('unused')),
    },
  };
}

describe('site tools', () => {
  it('create_asset makes a draft owned by the session user; publish_asset pulls the folder and publishes it', async () => {
    const c = ctx('alice', { 'landing/index.html': '<h1>Hi</h1>', 'landing/img/logo.svg': '<svg/>', 'other.txt': 'no' });
    const created = (await createAssetTool.handler(createAssetTool.input.parse({ title: 'Uncage', kind: 'landing-page' }), c)) as { assetId: string };
    expect((await assets().get(created.assetId))?.owner).toBe('alice');
    expect((await assets().get(created.assetId))?.sessionId).toBe('sess_1');

    const out = (await publishAssetTool.handler({ assetId: created.assetId, dir: 'landing' }, c)) as { files: string[]; url: string };
    expect(c.pulled).toEqual(['landing']);
    expect(out.files).toEqual(['img/logo.svg', 'index.html']);
    expect(out.url).toBe(`/assets/${created.assetId}`);
    expect(dec((await assets().readFile(created.assetId, 'index.html'))?.data)).toBe('<h1>Hi</h1>');
  });

  it('publish_asset refuses another user\'s asset without pulling anything', async () => {
    const a = await assets().create({ owner: 'bob', title: 'x', kind: 'landing-page', sessionId: 's' });
    const c = ctx('alice', { 'landing/index.html': 'x' });
    await expect(publishAssetTool.handler({ assetId: a.id, dir: 'landing' }, c)).rejects.toThrow(/Unknown asset/);
    expect(c.pulled).toEqual([]);
  });

  it('publish_asset needs confirmation; create_asset does not; kind is fixed', () => {
    expect(publishAssetTool.requiresConfirmation).toBe(true);
    expect(createAssetTool.requiresConfirmation).toBeFalsy();
    expect(createAssetTool.input.safeParse({ title: 't', kind: 'blog' }).success).toBe(false);
  });

  it('create_asset caps each owner at PUBLIC_MAX_ASSETS_PER_OWNER assets in public mode only', async () => {
    const input = createAssetTool.input.parse({ title: 't', kind: 'landing-page' });
    for (let i = 0; i < PUBLIC_MAX_ASSETS_PER_OWNER; i++) await assets().create({ owner: 'guest-a', title: `p${i}`, kind: 'landing-page', sessionId: 's' });
    // Not public: no cap.
    await expect(createAssetTool.handler(input, ctx('guest-a', {}))).resolves.toMatchObject({ status: 'draft' });
    process.env.DEMO_PUBLIC = '1';
    try {
      await expect(createAssetTool.handler(input, ctx('guest-a', {}))).rejects.toThrow(/at most 20 assets per visitor/);
      // Other guests are unaffected.
      await expect(createAssetTool.handler(input, ctx('guest-b', {}))).resolves.toMatchObject({ status: 'draft' });
    } finally {
      delete process.env.DEMO_PUBLIC;
    }
    expect((await assets().list('guest-a')).length).toBe(PUBLIC_MAX_ASSETS_PER_OWNER + 1);
  });

  it('maps pulled paths to page-relative ones; never falls back to basenames', () => {
    expect(pageRelative('landing', 'landing/index.html')).toBe('index.html');
    expect(pageRelative('./landing/', 'landing/a/b.css')).toBe('a/b.css');
    expect(pageRelative('landing//', 'landing/index.html')).toBe('index.html');
    for (const root of ['.', './', '', '/']) expect(pageRelative(root, 'css/app.css')).toBe('css/app.css');
    expect(() => pageRelative('landing/index.html', 'landing/index.html')).toThrow(/folder/);
    expect(() => pageRelative('landing', 'other/index.html')).toThrow(/folder/);
    expect(() => pageRelative('land', 'landing/index.html')).toThrow(/folder/);
  });

  it('publish_asset refuses a file instead of a folder and publishes nothing', async () => {
    const c = ctx('alice', { 'landing/index.html': '<h1>Hi</h1>' });
    const a = await assets().create({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    await expect(publishAssetTool.handler({ assetId: a.id, dir: 'landing/index.html' }, c)).rejects.toThrow(/folder/);
    expect((await assets().get(a.id))?.status).toBe('draft');
  });
});

describe('asset CSP', () => {
  it('allows inline code and same-asset sub-resources only; no network, sandboxed', () => {
    const csp = assetCsp('http://localhost:3200', 'a_abcdefghijkl');
    const dirs = Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));
    const own = 'http://localhost:3200/asset-files/a_abcdefghijkl/';
    expect(dirs['default-src']).toEqual(["'none'"]);
    expect(dirs['connect-src']).toEqual(["'none'"]);
    for (const d of ['style-src', 'script-src', 'img-src', 'font-src', 'media-src']) expect(dirs[d]).toContain(own);
    expect(dirs['style-src']).toContain("'unsafe-inline'");
    expect(dirs['script-src']).toContain("'unsafe-inline'");
    expect(dirs.sandbox).toEqual(['allow-scripts']);
    expect(dirs['frame-ancestors']).toEqual(["'self'"]);
    expect(csp).not.toContain('/asset-files/ ');
  });
});

describe('public demo asset access and cleanup', () => {
  it('canReadAsset: published is open outside public mode, owner-only in public mode, drafts never', async () => {
    const a = await assets().create({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    for (const pub of [false, true]) expect(canReadAsset(a, 'alice', pub)).toBe(false); // draft
    const p = await assets().publish(a.id, [{ path: 'index.html', data: enc('x') }]);
    expect(canReadAsset(p, 'bob', false)).toBe(true);
    expect(canReadAsset(p, null, false)).toBe(true);
    expect(canReadAsset(p, 'alice', true)).toBe(true);
    expect(canReadAsset(p, 'bob', true)).toBe(false);
    expect(canReadAsset(p, null, true)).toBe(false);
  });

  it('purgeAssetsOlderThan removes only assets past the max age', async () => {
    const old = await assets().create({ owner: 'alice', title: 'old', kind: 'landing-page', sessionId: 's' });
    const fresh = await assets().create({ owner: 'alice', title: 'new', kind: 'landing-page', sessionId: 's' });
    const metaFile = join(dir, 'assets', old.id, 'meta.json');
    const meta = JSON.parse(await readFile(metaFile, 'utf8')) as { createdAt: string };
    meta.createdAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    await writeFile(metaFile, JSON.stringify(meta));
    expect(await assets().purgeOlderThan(24 * 3600_000)).toBe(1);
    expect((await assets().list('alice')).map((x) => x.id)).toEqual([fresh.id]);
    expect(await assets().purgeOlderThan(24 * 3600_000)).toBe(0);
  });

  it('purge ages an asset from its last publish, not only its creation', async () => {
    const a = await assets().create({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    await assets().publish(a.id, [{ path: 'index.html', data: enc('x') }]);
    const metaFile = join(dir, 'assets', a.id, 'meta.json');
    const meta = JSON.parse(await readFile(metaFile, 'utf8')) as { createdAt: string };
    meta.createdAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    await writeFile(metaFile, JSON.stringify(meta));
    expect(await assets().purgeOlderThan(24 * 3600_000)).toBe(0); // published just now
  });

  it('owner-checks page-like requests only; sub-resources of a published asset stay readable', async () => {
    for (const d of [null, 'document', 'iframe', 'frame', 'embed', 'object']) expect(needsOwnerCheck(d)).toBe(true);
    for (const d of ['style', 'script', 'image', 'font', 'audio']) expect(needsOwnerCheck(d)).toBe(false);
    const a = await assets().create({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    const p = await assets().publish(a.id, [{ path: 'index.html', data: enc('x') }]);
    expect(canReadAsset(p, 'bob', needsOwnerCheck('document'))).toBe(false);
    expect(canReadAsset(p, 'bob', needsOwnerCheck('style'))).toBe(true);
    expect(canReadAsset(p, 'alice', needsOwnerCheck('iframe'))).toBe(true);
    expect(canReadAsset(a, 'bob', needsOwnerCheck('style'))).toBe(false); // draft
  });

  it('owner-checks fetch-style (empty) requests only when a signed-in non-owner sends them', async () => {
    const a = await assets().create({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    const p = await assets().publish(a.id, [{ path: 'index.html', data: enc('x') }]);
    // Cookieless (from the sandboxed iframe): readable, guarded by the unguessable id.
    expect(needsOwnerCheck('empty', null, 'alice')).toBe(false);
    expect(canReadAsset(p, null, needsOwnerCheck('empty', null, p.owner))).toBe(true);
    // Another signed-in guest: checked and refused.
    expect(needsOwnerCheck('empty', 'bob', 'alice')).toBe(true);
    expect(canReadAsset(p, 'bob', needsOwnerCheck('empty', 'bob', p.owner))).toBe(false);
    // The owner: readable.
    expect(canReadAsset(p, 'alice', needsOwnerCheck('empty', 'alice', p.owner))).toBe(true);
    // Other sub-resource kinds stay unchecked even with a user; page-like ones stay checked without one.
    expect(needsOwnerCheck('style', 'bob', 'alice')).toBe(false);
    expect(needsOwnerCheck('document', null, 'alice')).toBe(true);
  });
});

describe('landing-page skill', () => {
  it('keeps its rules and carries accurate facts about Uncage', () => {
    const text = makeLandingPageSkill({}).markdown;
    expect(landingPageSkill.name).toBe('landing-page');
    for (const rule of ['create_asset', 'publish_asset', 'No external resources', 'landing/index.html']) expect(text).toContain(rule);
    expect(text).toContain('## About Uncage');
    expect(text).toContain('npm packages');
    expect(text).toContain("each user's own\nClaude Code");
    expect(text).toContain('**site tools**');
    expect(text).toContain('**skills**');
    expect(text).toContain('**Approvals**');
    expect(text).toContain('stay on the website');
    expect(text).toContain('MIT');
    expect(text).toContain(`Documentation: ${DEFAULT_DOCS_URL}`);
    expect(DEFAULT_DOCS_URL).toBe('https://uncage.vercel.app/docs/');
  });
  it('links the docs from DOCS_URL when it is set', () => {
    expect(makeLandingPageSkill({ DOCS_URL: 'https://uncage.example/docs/' }).markdown).toContain('Documentation: https://uncage.example/docs/');
  });
  it('normalizes DOCS_URL like the help site normalizes SITE_URL', () => {
    expect(docsUrl({})).toBeUndefined();
    expect(docsUrl({ DOCS_URL: '' })).toBeUndefined();
    expect(docsUrl({ DOCS_URL: 'https://uncage.example/docs' })).toBe('https://uncage.example/docs/');
    expect(docsUrl({ DOCS_URL: 'https://uncage.example/docs//' })).toBe('https://uncage.example/docs/');
    expect(makeLandingPageSkill({ DOCS_URL: '' }).markdown).toContain(`Documentation: ${DEFAULT_DOCS_URL}`);
  });
});

/**
 * A one-connection `pg.Pool` look-alike over PGlite, so postgresAssetStore runs without a server:
 * `connect()` hands the connection out exclusively until `release()` (a pool of size 1).
 */
function pglitePool(db: PGlite): PgPoolLike {
  let lock: Promise<void> = Promise.resolve();
  const acquire = async (): Promise<() => void> => {
    let release!: () => void;
    const prev = lock;
    lock = new Promise<void>((r) => (release = r));
    await prev;
    return release;
  };
  const run = async (sql: string, params?: unknown[]) => ({ rows: (await db.query(sql, params)).rows as unknown[] });
  return {
    async query(sql, params) {
      const release = await acquire();
      try {
        return await run(sql, params);
      } finally {
        release();
      }
    },
    async connect() {
      return { query: run, release: await acquire() };
    },
    end: () => db.close(),
  };
}

/**
 * Real Postgres for the concurrency checks: `DEMO_TEST_DATABASE_URL` (e.g. a throwaway
 * `docker run postgres:16-alpine`). Without it those tests are skipped.
 */
const realDb = process.env.DEMO_TEST_DATABASE_URL;

describe.each([
  ['fileAssetStore', async () => ({ store: fileAssetStore(join(dir, 'assets')), close: async () => undefined })],
  [
    'postgresAssetStore (PGlite)',
    async () => {
      const db = new PGlite();
      return { store: postgresAssetStore(pglitePool(db)), close: () => db.close() };
    },
  ],
] as const)('asset store contract: %s', (_name, make) => {
  let store: AssetStore;
  let close: () => Promise<void>;
  beforeEach(async () => ({ store, close } = await make()));
  afterEach(() => close());

  it('creates, lists newest first per owner, counts, publishes and serves only published files', async () => {
    const a = await store.create({ owner: 'alice', title: 'One', kind: 'landing-page', sessionId: 's1' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ owner: 'alice', title: 'Two', kind: 'landing-page', sessionId: 's2' });
    await store.create({ owner: 'bob', title: 'Other', kind: 'landing-page', sessionId: 's3' });
    expect(a.id).toMatch(/^a_[A-Za-z0-9_-]{12}$/);
    expect(await store.get(a.id)).toEqual(a);
    expect((await store.list('alice')).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(await store.count('alice')).toBe(2);
    expect(await store.count('nobody')).toBe(0);
    expect(await store.readFile(a.id, 'index.html')).toBeNull(); // draft

    const p = await store.publish(a.id, [
      { path: 'index.html', data: enc('<h1>One</h1>') },
      { path: 'css/app.css', data: enc('h1{}') },
    ]);
    expect(p.status).toBe('published');
    expect(p.files).toEqual([
      { path: 'css/app.css', size: 4 },
      { path: 'index.html', size: 12 },
    ]);
    expect(await store.get(a.id)).toEqual(p);
    const file = await store.readFile(a.id, 'index.html');
    expect(file?.contentType).toBe('text/html; charset=utf-8');
    expect(dec(file?.data)).toBe('<h1>One</h1>');
    expect((await store.readFile(a.id, 'css/app.css'))?.contentType).toBe('text/css; charset=utf-8');
    // A republish replaces every file.
    await store.publish(a.id, [{ path: 'index.html', data: enc('v2') }]);
    expect(dec((await store.readFile(a.id, 'index.html'))?.data)).toBe('v2');
    expect(await store.readFile(a.id, 'css/app.css')).toBeNull();
    expect(await store.readFile(a.id, '../meta.json')).toBeNull();
    expect(await store.readFile(a.id, 'missing.html')).toBeNull();
    expect(await store.get('../../etc')).toBeNull();
    expect(await store.get('a_doesnotexist')).toBeNull();
  });

  it('refuses a bad publish without changing the asset', async () => {
    const a = await store.create({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    await expect(store.publish(a.id, [{ path: 'page.html', data: enc('x') }])).rejects.toThrow(/index\.html/);
    await expect(store.publish(a.id, [{ path: 'index.html', data: enc('x') }, { path: '../x', data: enc('x') }])).rejects.toThrow(/Unsupported/);
    await expect(store.publish(a.id, [])).rejects.toThrow(/empty/);
    await expect(store.publish('a_doesnotexist', [{ path: 'index.html', data: enc('x') }])).rejects.toThrow(/Unknown asset/);
    expect((await store.get(a.id))?.status).toBe('draft');
  });

  it(`holds ${PUBLIC_MAX_ASSETS_PER_OWNER} assets per owner (the public quota refuses the next) and a ${PUBLISH_MAX_BYTES / 1024 / 1024} MB publish`, async () => {
    for (let i = 0; i < PUBLIC_MAX_ASSETS_PER_OWNER; i++) await store.create({ owner: 'guest-a', title: `p${i}`, kind: 'landing-page', sessionId: 's' });
    expect(await store.count('guest-a')).toBe(PUBLIC_MAX_ASSETS_PER_OWNER);
    const o = { title: 'x', kind: 'landing-page' as const, sessionId: 's' };
    await expect(store.create({ ...o, owner: 'guest-a' }, { maxPerOwner: PUBLIC_MAX_ASSETS_PER_OWNER })).rejects.toThrow(AssetQuotaError);
    await expect(store.create({ ...o, owner: 'guest-a' }, { maxPerOwner: PUBLIC_MAX_ASSETS_PER_OWNER })).rejects.toThrow(/at most 20 assets per visitor/);
    expect(await store.count('guest-a')).toBe(PUBLIC_MAX_ASSETS_PER_OWNER);
    await expect(store.create({ ...o, owner: 'guest-b' }, { maxPerOwner: PUBLIC_MAX_ASSETS_PER_OWNER })).resolves.toMatchObject({ owner: 'guest-b' });
    await expect(store.create({ ...o, owner: 'guest-a' })).resolves.toMatchObject({ owner: 'guest-a' }); // no limit asked
    expect(await store.count('guest-a')).toBe(PUBLIC_MAX_ASSETS_PER_OWNER + 1);

    const first = (await store.list('guest-a')).at(-1);
    const half = PUBLISH_MAX_BYTES / 2;
    const big = (seed: number) => Uint8Array.from({ length: half }, (_, i) => (i * 31 + seed) & 255);
    await store.publish(first!.id, [
      { path: 'index.html', data: big(1) },
      { path: 'img/hero.png', data: big(7) },
    ]);
    const back = await store.readFile(first!.id, 'img/hero.png');
    expect(back?.data.byteLength).toBe(half);
    expect(Buffer.from(back!.data).equals(Buffer.from(big(7)))).toBe(true);
    expect((await store.get(first!.id))?.files?.reduce((n, f) => n + f.size, 0)).toBe(PUBLISH_MAX_BYTES);
  }, 60_000);

  it('purges assets last created or published more than the max age ago, with their files', async () => {
    const old = await store.create({ owner: 'alice', title: 'old', kind: 'landing-page', sessionId: 's' });
    await store.publish(old.id, [{ path: 'index.html', data: enc('x') }]);
    const later = Date.now() + 25 * 3600_000;
    const fresh = await store.create({ owner: 'alice', title: 'new', kind: 'landing-page', sessionId: 's' });
    // Seen from 25 h later both are old; from now neither is.
    expect(await store.purgeOlderThan(24 * 3600_000)).toBe(0);
    expect(await store.purgeOlderThan(24 * 3600_000, later)).toBe(2);
    expect(await store.list('alice')).toEqual([]);
    expect(await store.readFile(old.id, 'index.html')).toBeNull();
    expect(await store.get(fresh.id)).toBeNull();
  });

  it('a total storage cap refuses publishes and creates past it, with a friendly error; republishing does not count twice', async () => {
    const limits = { maxTotalBytes: 100 };
    const a = await store.create({ owner: 'alice', title: 'a', kind: 'landing-page', sessionId: 's' }, limits);
    await store.publish(a.id, [{ path: 'index.html', data: new Uint8Array(60) }], limits);
    // Replacing a's files with the same size fits (its old files do not count).
    await store.publish(a.id, [{ path: 'index.html', data: new Uint8Array(60) }], limits);
    expect(await store.totalBytes()).toBe(60);
    const b = await store.create({ owner: 'bob', title: 'b', kind: 'landing-page', sessionId: 's' }, limits);
    const full = store.publish(b.id, [{ path: 'index.html', data: new Uint8Array(50) }], limits);
    await expect(full).rejects.toBeInstanceOf(AssetStorageFullError);
    await expect(full).rejects.toThrow(/storage is full.*try again later/);
    expect(await store.readFile(b.id, 'index.html')).toBeNull();
    await store.publish(b.id, [{ path: 'index.html', data: new Uint8Array(40) }], limits);
    // Now at the cap: no new asset.
    await expect(store.create({ owner: 'carol', title: 'c', kind: 'landing-page', sessionId: 's' }, limits)).rejects.toBeInstanceOf(AssetStorageFullError);
    // Without limits (not a public demo) nothing is refused.
    await store.create({ owner: 'carol', title: 'c', kind: 'landing-page', sessionId: 's' });
  });
});

describe('two modes: traditional (server.ts) and FaaS (next start / Vercel)', () => {
  const g = globalThis as Record<symbol, unknown>;
  afterEach(() => {
    delete g[PUBLISHED_HUB_KEY];
  });

  it('demoMode is traditional when server.ts published a hub and faas otherwise', () => {
    expect(demoMode()).toBe('faas');
    publishHub({ basePath: '/api/uncage' } as never);
    expect(demoMode()).toBe('traditional');
  });

  it('getHub returns the published hub in traditional mode', async () => {
    const hub = { basePath: '/api/uncage' } as never;
    publishHub(hub);
    expect(await getHub()).toBe(hub);
  });

  it('FaaS mode without DEMO_SECRET or DATABASE_URL fails with a message naming the missing variables', async () => {
    expect(() => requireFaasEnv({})).toThrow(/DATABASE_URL[\s\S]*DEMO_SECRET/);
    expect(() => requireFaasEnv({ DATABASE_URL: 'postgres://x' })).toThrow(/DEMO_SECRET/);
    expect(() => requireFaasEnv({ DATABASE_URL: 'postgres://x' })).not.toThrow(/DATABASE_URL/);
    expect(() => requireFaasEnv({ DEMO_SECRET: 's'.repeat(32) })).toThrow(/DATABASE_URL/);
    // In production a public URL is required (PUBLIC_URL, or the platform's: Vercel's production domain).
    const ok = { DATABASE_URL: 'postgres://x', DEMO_SECRET: 's'.repeat(32) };
    expect(() => requireFaasEnv(ok)).not.toThrow();
    expect(() => requireFaasEnv({ ...ok, NODE_ENV: 'production' })).toThrow(/PUBLIC_URL/);
    expect(() => requireFaasEnv({ ...ok, NODE_ENV: 'production', PUBLIC_URL: 'https://demo.example' })).not.toThrow();
    expect(() => requireFaasEnv({ ...ok, NODE_ENV: 'production', VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'demo.vercel.app' })).not.toThrow();
    expect(() => requireFaasEnv({ DATABASE_URL: 'postgres://x', DEMO_SECRET: 'short' })).toThrow(/DEMO_SECRET is shorter than 32 bytes/);
    expect(() => requireFaasEnv({ DATABASE_URL: 'postgres://x', DEMO_SECRET: 's'.repeat(32) })).not.toThrow();
    // The hub refuses to start, and so does the cookie key: FaaS mode never falls back to the disk.
    await expect(createDemoHub({ mode: 'faas', env: { DEMO_DATA_DIR: dir } })).rejects.toThrow(/DATABASE_URL[\s\S]*DEMO_SECRET/);
    expect(() => secret({ DEMO_DATA_DIR: dir }, 'faas')).toThrow(/DEMO_SECRET/);
    expect(await readdir(dir)).toEqual([]); // nothing written
    const key = 'k'.repeat(40);
    expect(secret({ DATABASE_URL: 'postgres://x', DEMO_SECRET: key, DEMO_DATA_DIR: dir }, 'faas').toString()).toBe(key);
    expect(await readdir(dir)).toEqual([]);
  });

  it('getHub in FaaS mode surfaces the missing variables and retries on the next call', async () => {
    const saved = { DATABASE_URL: process.env.DATABASE_URL, DEMO_SECRET: process.env.DEMO_SECRET };
    delete process.env.DATABASE_URL;
    delete process.env.DEMO_SECRET;
    try {
      await expect(getHub()).rejects.toThrow(/DATABASE_URL/);
      await expect(getHub()).rejects.toThrow(/DATABASE_URL/); // not memoized
    } finally {
      Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
    }
  });
});

describe('FaaS attachment limit', () => {
  const upload = (bytes: number | null, path = '/api/uncage/sessions/sess_1/attachments', method = 'POST') =>
    new Request(`http://localhost:3200${path}`, { method, headers: bytes === null ? {} : { 'content-length': String(bytes) } });
  it('answers an attachment over 4 MB with the hub-shaped 413; everything else passes through', async () => {
    const res = faasAttachmentLimit(upload(FAAS_ATTACHMENT_MAX_BYTES + 1));
    expect(res?.status).toBe(413);
    expect(await res?.json()).toMatchObject({ error: { code: 'attachment_too_large', details: { maxBytes: 4 * 1024 * 1024 } } });
    expect(faasAttachmentLimit(upload(FAAS_ATTACHMENT_MAX_BYTES))).toBeNull();
    expect(faasAttachmentLimit(upload(null))).toBeNull();
    expect(faasAttachmentLimit(upload(10_000_000, '/api/uncage/agent/events'))).toBeNull();
    expect(faasAttachmentLimit(upload(10_000_000, '/api/uncage/sessions/sess_1/attachments', 'GET'))).toBeNull();
  });
});

/** 10 parallel creates of one guest holding 15: exactly 20 in the end, 5 refused. */
async function parallelQuota(store: AssetStore, owner: string): Promise<void> {
  const o = { owner, title: 'x', kind: 'landing-page' as const, sessionId: 's' };
  for (let i = 0; i < 15; i++) await store.create(o);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => store.create(o, { maxPerOwner: PUBLIC_MAX_ASSETS_PER_OWNER })));
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
  const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  expect(refused).toHaveLength(5);
  for (const r of refused) expect(r.reason).toBeInstanceOf(AssetQuotaError);
  expect(await store.count(owner)).toBe(PUBLIC_MAX_ASSETS_PER_OWNER);
}

describe('atomic public quota (postgresAssetStore)', () => {
  it('PGlite: 10 parallel creates from one guest never pass 20', async () => {
    const db = new PGlite();
    try {
      await parallelQuota(postgresAssetStore(pglitePool(db)), 'guest-p');
    } finally {
      await db.close();
    }
  });

  it.skipIf(!realDb)('real Postgres (pool of 10): 10 parallel creates from one guest never pass 20', async () => {
    const pool = sharedPool(realDb!, { DATABASE_POOL_MAX: '10' });
    try {
      await parallelQuota(postgresAssetStore(pool), `guest-${randomBytes(6).toString('hex')}`);
    } finally {
      await endSharedPool(realDb!);
    }
  });
});

describe('one shared pg pool per instance', () => {
  it('sharedPool returns one pool per URL; endSharedPool ends it once; the asset store follows it', async () => {
    const url = 'postgres://u:p@127.0.0.1:1/never-connected';
    const a = sharedPool(url);
    expect(sharedPool(url)).toBe(a);
    expect(a.options.max).toBe(5);
    const store = assetStore({ DATABASE_URL: url });
    expect(assetStore({ DATABASE_URL: url })).toBe(store);
    await endSharedPool(url);
    await endSharedPool(url); // once: no "Called end on pool more than once"
    expect(a.ended).toBe(true);
    const b = sharedPool(url);
    expect(b).not.toBe(a);
    expect(assetStore({ DATABASE_URL: url })).not.toBe(store);
    await endSharedPool(url);
  });

  it.skipIf(!realDb)('FaaS hub, cluster and assets share one pool of at most 5; close ends it', async () => {
    const env = { DATABASE_URL: realDb!, DEMO_SECRET: 's'.repeat(32), DEMO_PUBLIC: '1' };
    const { hub, close } = await createDemoHub({ mode: 'faas', env });
    const pool = sharedPool(realDb!);
    await assetStore(env).count('nobody');
    await hub.maintain();
    expect(pool.totalCount).toBeGreaterThan(0);
    expect(pool.totalCount).toBeLessThanOrEqual(5);
    await close();
    expect(pool.ended).toBe(true);
  });
});

describe('publish size per mode', () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[PUBLISHED_HUB_KEY];
  });
  it('20 MB in traditional mode, 5 MB in FaaS mode', () => {
    expect(publishMaxBytes()).toBe(FAAS_PUBLISH_MAX_BYTES);
    expect(FAAS_PUBLISH_MAX_BYTES).toBe(5 * 1024 * 1024);
    publishHub({ basePath: '/api/uncage' } as never);
    expect(publishMaxBytes()).toBe(PUBLISH_MAX_BYTES);
  });
});
