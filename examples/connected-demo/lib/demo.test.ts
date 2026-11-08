import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@uncage/hub';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assetCsp } from './asset-csp.ts';
import { canReadAsset, createAsset, getAsset, listAssets, needsOwnerCheck, publishAsset, purgeAssetsOlderThan, readAssetFile } from './assets.ts';
import { guestUsername, normalizeUsername, readCookie, secret, signUser, verifyUser } from './auth.ts';
import { docsUrl, isPublicDemo, publicUrl } from './config.ts';
import { isSameOrigin } from './csrf.ts';
import { clientIpResolver, forwardedClient } from './hub.ts';
import { safeNext } from './session-utils.ts';
import { DEFAULT_DOCS_URL, landingPageSkill, makeLandingPageSkill } from './skills.ts';
import { createAssetTool, pageRelative, PUBLIC_MAX_ASSETS_PER_OWNER, publishAssetTool } from './tools.ts';

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
    expect(secret({ ...process.env, DEMO_SECRET: strong, DEMO_DATA_DIR: dir }).toString()).toBe(strong);
    expect(warn).not.toHaveBeenCalled();
    const weak = secret({ ...process.env, DEMO_SECRET: 'short', DEMO_DATA_DIR: dir });
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
  });
});

describe('asset store', () => {
  it('creates, lists per owner, publishes and serves only published files inside the page', async () => {
    const a = await createAsset({ owner: 'alice', title: 'Uncage', kind: 'landing-page', sessionId: 's1' });
    await createAsset({ owner: 'bob', title: 'Other', kind: 'landing-page', sessionId: 's2' });
    expect((await listAssets('alice')).map((x) => x.id)).toEqual([a.id]);
    expect(await readAssetFile(a.id, 'index.html')).toBeNull(); // draft

    await publishAsset(a.id, [
      { path: 'index.html', data: enc('<h1>Uncage</h1>') },
      { path: 'css/app.css', data: enc('h1{}') },
    ]);
    const got = await getAsset(a.id);
    expect(got?.status).toBe('published');
    expect(got?.files?.map((f) => f.path)).toEqual(['css/app.css', 'index.html']);
    const file = await readAssetFile(a.id, 'index.html');
    expect(file?.contentType).toBe('text/html; charset=utf-8');
    expect(file?.data.toString()).toBe('<h1>Uncage</h1>');
    expect(await readAssetFile(a.id, '../meta.json')).toBeNull();
    expect(await readAssetFile(a.id, 'missing.html')).toBeNull();
    expect(await getAsset('../../etc')).toBeNull();
  });

  it('removes the staging dir when a publish fails part-way', async () => {
    const a = await createAsset({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    // "index.html" as a file and as a directory: the second write fails after staging was created.
    await expect(
      publishAsset(a.id, [
        { path: 'index.html', data: enc('x') },
        { path: 'index.html/x.css', data: enc('x') },
      ]),
    ).rejects.toThrow();
    expect((await readdir(join(dir, 'assets', a.id))).sort()).toEqual(['meta.json']);
    expect((await getAsset(a.id))?.status).toBe('draft');
  });

  it('refuses a publish without index.html or with unsafe paths', async () => {
    const a = await createAsset({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    await expect(publishAsset(a.id, [{ path: 'page.html', data: enc('x') }])).rejects.toThrow(/index\.html/);
    await expect(publishAsset(a.id, [{ path: 'index.html', data: enc('x') }, { path: '../x', data: enc('x') }])).rejects.toThrow(/Unsupported/);
    await expect(publishAsset(a.id, [])).rejects.toThrow(/empty/);
    expect((await getAsset(a.id))?.status).toBe('draft');
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
    expect((await getAsset(created.assetId))?.owner).toBe('alice');
    expect((await getAsset(created.assetId))?.sessionId).toBe('sess_1');

    const out = (await publishAssetTool.handler({ assetId: created.assetId, dir: 'landing' }, c)) as { files: string[]; url: string };
    expect(c.pulled).toEqual(['landing']);
    expect(out.files).toEqual(['img/logo.svg', 'index.html']);
    expect(out.url).toBe(`/assets/${created.assetId}`);
    expect((await readAssetFile(created.assetId, 'index.html'))?.data.toString()).toBe('<h1>Hi</h1>');
  });

  it('publish_asset refuses another user\'s asset without pulling anything', async () => {
    const a = await createAsset({ owner: 'bob', title: 'x', kind: 'landing-page', sessionId: 's' });
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
    for (let i = 0; i < PUBLIC_MAX_ASSETS_PER_OWNER; i++) await createAsset({ owner: 'guest-a', title: `p${i}`, kind: 'landing-page', sessionId: 's' });
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
    expect((await listAssets('guest-a')).length).toBe(PUBLIC_MAX_ASSETS_PER_OWNER + 1);
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
    const a = await createAsset({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    await expect(publishAssetTool.handler({ assetId: a.id, dir: 'landing/index.html' }, c)).rejects.toThrow(/folder/);
    expect((await getAsset(a.id))?.status).toBe('draft');
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
    const a = await createAsset({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    for (const pub of [false, true]) expect(canReadAsset(a, 'alice', pub)).toBe(false); // draft
    const p = await publishAsset(a.id, [{ path: 'index.html', data: enc('x') }]);
    expect(canReadAsset(p, 'bob', false)).toBe(true);
    expect(canReadAsset(p, null, false)).toBe(true);
    expect(canReadAsset(p, 'alice', true)).toBe(true);
    expect(canReadAsset(p, 'bob', true)).toBe(false);
    expect(canReadAsset(p, null, true)).toBe(false);
  });

  it('purgeAssetsOlderThan removes only assets past the max age', async () => {
    const old = await createAsset({ owner: 'alice', title: 'old', kind: 'landing-page', sessionId: 's' });
    const fresh = await createAsset({ owner: 'alice', title: 'new', kind: 'landing-page', sessionId: 's' });
    const metaFile = join(dir, 'assets', old.id, 'meta.json');
    const meta = JSON.parse(await readFile(metaFile, 'utf8')) as { createdAt: string };
    meta.createdAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    await writeFile(metaFile, JSON.stringify(meta));
    expect(await purgeAssetsOlderThan(24 * 3600_000)).toBe(1);
    expect((await listAssets('alice')).map((x) => x.id)).toEqual([fresh.id]);
    expect(await purgeAssetsOlderThan(24 * 3600_000)).toBe(0);
  });

  it('purge ages an asset from its last publish, not only its creation', async () => {
    const a = await createAsset({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    await publishAsset(a.id, [{ path: 'index.html', data: enc('x') }]);
    const metaFile = join(dir, 'assets', a.id, 'meta.json');
    const meta = JSON.parse(await readFile(metaFile, 'utf8')) as { createdAt: string };
    meta.createdAt = new Date(Date.now() - 25 * 3600_000).toISOString();
    await writeFile(metaFile, JSON.stringify(meta));
    expect(await purgeAssetsOlderThan(24 * 3600_000)).toBe(0); // published just now
  });

  it('owner-checks page-like requests only; sub-resources of a published asset stay readable', async () => {
    for (const d of [null, 'document', 'iframe', 'frame', 'embed', 'object']) expect(needsOwnerCheck(d)).toBe(true);
    for (const d of ['style', 'script', 'image', 'font', 'audio']) expect(needsOwnerCheck(d)).toBe(false);
    const a = await createAsset({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    const p = await publishAsset(a.id, [{ path: 'index.html', data: enc('x') }]);
    expect(canReadAsset(p, 'bob', needsOwnerCheck('document'))).toBe(false);
    expect(canReadAsset(p, 'bob', needsOwnerCheck('style'))).toBe(true);
    expect(canReadAsset(p, 'alice', needsOwnerCheck('iframe'))).toBe(true);
    expect(canReadAsset(a, 'bob', needsOwnerCheck('style'))).toBe(false); // draft
  });

  it('owner-checks fetch-style (empty) requests only when a signed-in non-owner sends them', async () => {
    const a = await createAsset({ owner: 'alice', title: 'x', kind: 'landing-page', sessionId: 's' });
    const p = await publishAsset(a.id, [{ path: 'index.html', data: enc('x') }]);
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
    expect(DEFAULT_DOCS_URL).toBe('https://uncage-dev.vercel.app/docs/');
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
