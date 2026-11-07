import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@uncage/hub';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAsset, getAsset, listAssets, publishAsset, readAssetFile } from './assets.ts';
import { normalizeUsername, readCookie, signUser, verifyUser } from './auth.ts';
import { isSameOrigin } from './csrf.ts';
import { forwardedClient } from './hub.ts';
import { safeNext } from './session-utils.ts';
import { createAssetTool, pageRelative, publishAssetTool } from './tools.ts';

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

  it('maps pulled paths to page-relative ones', () => {
    expect(pageRelative('landing', 'landing/index.html')).toBe('index.html');
    expect(pageRelative('./landing/', 'landing/a/b.css')).toBe('a/b.css');
    expect(pageRelative('landing/index.html', 'landing/index.html')).toBe('index.html');
  });
});
