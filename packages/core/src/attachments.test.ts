import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeAdapter, type FakeStep } from '@uncage/testkit';
import { ATTACHMENT_LIMITS, type RuntimeAdapter, type RuntimeCapabilities } from '@uncage/protocol';
import { displayFileName, publicAttachment, sanitizeFileName } from './attachments.js';
import { openPgliteStore } from './store/pglite-store.js';
import type { Store } from './store/store.js';
import { createUncage, type Uncage, type UncageOptions } from './uncage.js';
import { eventsUntil, isTerminal } from './test-utils.js';

const ATT_CAPS: Partial<RuntimeCapabilities> = {
  attachments: { images: true, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes },
};

const bytes = (s: string) => new TextEncoder().encode(s);

describe('sanitizeFileName', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['a\0b.txt', 'a_b.txt'],
    ['x/y.md', 'y.md'],
    ['C:\\temp\\evil.md', 'evil.md'],
    ['..', 'file'],
    ['.', 'file'],
    ['', 'file'],
    ['héllo wörld!!.txt', 'héllo wörld_.txt'],
    ['设计稿.png', '设计稿.png'],
    ['e\u0301te\u0301.md', 'été.md'],
    ['<script>.md', '_script_.md'],
  ])('%j → %j', (input, out) => {
    expect(sanitizeFileName(input)).toBe(out);
  });

  it('caps length at 120 UTF-8 bytes and keeps the extension', () => {
    const s = sanitizeFileName(`${'a'.repeat(300)}.md`);
    expect(s.length).toBe(120);
    expect(s.endsWith('.md')).toBe(true);
    const cjk = sanitizeFileName(`${'设'.repeat(300)}.png`);
    expect(Buffer.byteLength(cjk, 'utf8')).toBeLessThanOrEqual(120);
    expect(cjk).toBe(`${'设'.repeat(38)}.png`);
  });
});

describe('displayFileName', () => {
  it.each([
    ['设计稿.png', '设计稿.png'],
    ['a\0b.txt', 'ab.txt'],
    ['x/y.md', 'y.md'],
    ['../../etc/passwd', 'passwd'],
    ['bell\u0007.md', 'bell.md'],
    ['e\u0301.md', 'é.md'],
    ['..', 'file'],
    ['', 'file'],
  ])('%j → %j', (input, out) => {
    expect(displayFileName(input)).toBe(out);
  });

  it('caps at 200 characters and keeps the extension', () => {
    const d = displayFileName(`${'设'.repeat(300)}.png`);
    expect([...d]).toHaveLength(200);
    expect(d.endsWith('.png')).toBe(true);
  });
});

describe('attachments', () => {
  const open: Uncage[] = [];
  let dir: string;
  let ws: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uncage-att-'));
    ws = realpathSync(dir);
  });
  afterEach(async () => {
    for (const u of open.splice(0)) await u.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function make(adapters: RuntimeAdapter[], extra: Partial<UncageOptions> = {}) {
    const u = await createUncage({
      adapters,
      dataDir: 'memory://',
      workspace: { allowedRoots: [dir], default: dir },
      ...extra,
    });
    open.push(u);
    return u;
  }
  const fake = (script: FakeStep[] = [{ text: 'ok' }], caps: Partial<RuntimeCapabilities> = ATT_CAPS) =>
    createFakeAdapter({ script, capabilities: caps });
  const attDir = (sid: string) => join(ws, '.uncage', 'attachments', sid);

  it('stores file under workspace/.uncage/attachments/<sid>/ with sanitized name', async () => {
    const u = await make([fake()]);
    const s = await u.sessions.create({ runtime: 'fake' });
    const names = ['../../etc/passwd.txt', 'a\0b.txt', 'x/y.md', `${'a'.repeat(300)}.md`, '../../../escape.md'];
    for (const name of names) {
      const a = await u.attachments.add(s.id, { name, mime: 'text/plain', body: bytes(`content of ${name}`) });
      const { attachment, absPath } = await u.attachments.get(a.id);
      expect(attachment).toEqual(a);
      expect(absPath.startsWith(attDir(s.id) + sep)).toBe(true);
      expect(absPath.slice(attDir(s.id).length + 1)).toBe(`${a.id}-${sanitizeFileName(name)}`);
      expect(realpathSync(absPath).startsWith(attDir(s.id) + sep)).toBe(true);
      expect(readFileSync(absPath, 'utf8')).toBe(`content of ${name}`);
      expect(a.name).toBe(displayFileName(name));
      expect(a.sha256).toBe(createHash('sha256').update(`content of ${name}`).digest('hex'));
      expect(a.size).toBe(bytes(`content of ${name}`).length);
      expect(a.kind).toBe('file');
      expect(statSync(absPath).mode & 0o777).toBe(0o600);
    }
    expect(statSync(attDir(s.id)).mode & 0o777).toBe(0o700);
    expect(readdirSync(attDir(s.id))).toHaveLength(names.length);
    // Nothing escaped the workspace.
    expect(existsSync(join(ws, '..', 'escape.md'))).toBe(false);
  });

  it('accepts a streamed body (Node Readable)', async () => {
    const u = await make([fake()]);
    const s = await u.sessions.create({ runtime: 'fake' });
    const body = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    const a = await u.attachments.add(s.id, { name: 'img.png', mime: 'image/png', body });
    expect(a).toMatchObject({ kind: 'image', size: 11, mime: 'image/png', sessionId: s.id });
    expect(readFileSync((await u.attachments.get(a.id)).absPath, 'utf8')).toBe('hello world');
  });

  it('rejects 10MB+1 with attachment_too_large and leaves no file', async () => {
    const u = await make([fake()]);
    const s = await u.sessions.create({ runtime: 'fake' });
    const chunk = new Uint8Array(1024 * 1024);
    async function* body() {
      for (let i = 0; i < 10; i++) yield chunk;
      yield new Uint8Array(1);
    }
    await expect(u.attachments.add(s.id, { name: 'big.txt', mime: 'text/plain', body: body() })).rejects.toMatchObject({
      code: 'attachment_too_large',
    });
    await expect(
      u.attachments.add(s.id, { name: 'big.txt', mime: 'text/plain', body: new Uint8Array(ATTACHMENT_LIMITS.maxBytes + 1) }),
    ).rejects.toMatchObject({ code: 'attachment_too_large' });
    expect(existsSync(attDir(s.id)) ? readdirSync(attDir(s.id)) : []).toEqual([]);
    // Exactly the limit is fine.
    const ok = await u.attachments.add(s.id, {
      name: 'max.txt',
      mime: 'text/plain',
      body: new Uint8Array(ATTACHMENT_LIMITS.maxBytes),
    });
    expect(ok.size).toBe(ATTACHMENT_LIMITS.maxBytes);
  });

  it('enforces capabilities.attachments.maxImageBytes for images only, leaving no file', async () => {
    const MB5 = 5 * 1024 * 1024;
    const u = await make([fake([], { attachments: { images: true, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes, maxImageBytes: MB5 } })]);
    const s = await u.sessions.create({ runtime: 'fake' });
    const err = await u.attachments
      .add(s.id, { name: 'big.png', mime: 'image/png', body: new Uint8Array(MB5 + 1) })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'attachment_too_large', details: { maxBytes: MB5 } });
    expect((err as { hint: string }).hint).toMatch(/5 MB/);
    expect((err as { hint: string }).hint).toMatch(/image/i);
    expect(existsSync(attDir(s.id)) ? readdirSync(attDir(s.id)) : []).toEqual([]);
    expect((await u.attachments.add(s.id, { name: 'ok.png', mime: 'image/png', body: new Uint8Array(MB5) })).size).toBe(MB5);
    // Files keep the general limit.
    expect((await u.attachments.add(s.id, { name: 'f.txt', mime: 'text/plain', body: new Uint8Array(MB5 + 1) })).size).toBe(MB5 + 1);
  });

  it('rejects .exe', async () => {
    const u = await make([fake()]);
    const s = await u.sessions.create({ runtime: 'fake' });
    await expect(
      u.attachments.add(s.id, { name: 'tool.exe', mime: 'application/octet-stream', body: bytes('MZ') }),
    ).rejects.toMatchObject({ code: 'attachment_type_unsupported' });
    await expect(u.attachments.add(s.id, { name: 'x.png', mime: 'text/plain', body: bytes('x') })).rejects.toMatchObject({
      code: 'attachment_type_unsupported',
    });
    expect(existsSync(attDir(s.id)) ? readdirSync(attDir(s.id)) : []).toEqual([]);
  });

  it('image disallowed when capabilities.attachments.images false', async () => {
    const u = await make([
      fake([], { attachments: { images: false, files: true, maxBytes: ATTACHMENT_LIMITS.maxBytes } }),
    ]);
    const s = await u.sessions.create({ runtime: 'fake' });
    await expect(u.attachments.add(s.id, { name: 'a.png', mime: 'image/png', body: bytes('x') })).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
    expect((await u.attachments.add(s.id, { name: 'a.md', mime: 'text/markdown', body: bytes('x') })).kind).toBe('file');

    const u2 = await make([fake([], { attachments: { images: true, files: false, maxBytes: ATTACHMENT_LIMITS.maxBytes } })]);
    const s2 = await u2.sessions.create({ runtime: 'fake' });
    await expect(u2.attachments.add(s2.id, { name: 'a.md', mime: 'text/markdown', body: bytes('x') })).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
  });

  it('unknown session → not_found; unknown attachment → not_found', async () => {
    const u = await make([fake()]);
    await expect(u.attachments.add('ses_nope', { name: 'a.md', mime: 'text/plain', body: bytes('x') })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(u.attachments.get('att_nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps the original display name; on-disk name is readable', async () => {
    const u = await make([fake()]);
    const s = await u.sessions.create({ runtime: 'fake' });
    const a = await u.attachments.add(s.id, { name: '设计稿.png', mime: 'image/png', body: bytes('png') });
    expect(a.name).toBe('设计稿.png');
    expect((await u.attachments.get(a.id)).absPath).toBe(join(attDir(s.id), `${a.id}-设计稿.png`));
    const long = await u.attachments.add(s.id, { name: `${'设'.repeat(300)}.md`, mime: 'text/plain', body: bytes('x') });
    const onDisk = (await u.attachments.get(long.id)).absPath.slice(attDir(s.id).length + 1 + long.id.length + 1);
    expect(Buffer.byteLength(onDisk, 'utf8')).toBeLessThanOrEqual(120);
    expect([...long.name]).toHaveLength(200);
  });

  it('refuses a symlinked .uncage and creates nothing outside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'uncage-outside-'));
    try {
      symlinkSync(outside, join(ws, '.uncage'));
      const u = await make([fake()]);
      const s = await u.sessions.create({ runtime: 'fake' });
      await expect(u.attachments.add(s.id, { name: 'a.md', mime: 'text/plain', body: bytes('x') })).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked attachments dir (even one pointing inside the workspace)', async () => {
    mkdirSync(join(ws, 'src'));
    mkdirSync(join(ws, '.uncage'));
    symlinkSync(join(ws, 'src'), join(ws, '.uncage', 'attachments'));
    const u = await make([fake()]);
    const s = await u.sessions.create({ runtime: 'fake' });
    await expect(u.attachments.add(s.id, { name: 'a.md', mime: 'text/plain', body: bytes('x') })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(readdirSync(join(ws, 'src'))).toEqual([]);
  });

  it('read-only session → session_read_only', async () => {
    const lost = createFakeAdapter({ script: [], capabilities: ATT_CAPS });
    lost.run = async function* () {
      yield { type: 'native.session_lost', message: 'gone' };
    };
    const u = await make([lost]);
    const s = await u.sessions.create({ runtime: 'fake' });
    await s.startRun({ prompt: 'p' });
    await eventsUntil(s, isTerminal);
    await expect(u.attachments.add(s.id, { name: 'a.md', mime: 'text/plain', body: bytes('x') })).rejects.toMatchObject({
      code: 'session_read_only',
    });
  });

  it('startRun with more than maxPerMessage attachments → invalid_request', async () => {
    const u = await make([fake()]);
    const s = await u.sessions.create({ runtime: 'fake' });
    const ids: string[] = [];
    for (let i = 0; i <= ATTACHMENT_LIMITS.maxPerMessage; i++) {
      ids.push((await u.attachments.add(s.id, { name: `f${i}.md`, mime: 'text/plain', body: bytes('x') })).id);
    }
    await expect(s.startRun({ prompt: 'p', attachmentIds: ids })).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await s.snapshot()).runs).toEqual([]);
    expect((await s.startRun({ prompt: 'p', attachmentIds: ids.slice(1) })).attachments).toHaveLength(10);
  });

  it('attachment pruned between check and claim → invalid_request and no run', async () => {
    const base = await openPgliteStore({ dataDir: 'memory://' });
    const store: Store = {
      ...base,
      async listAttachments(ids) {
        const rows = await base.listAttachments(ids);
        await base.deleteOrphanAttachments(new Date(Date.now() + 60_000)); // the prune wins the race
        return rows;
      },
    };
    const adapter = fake();
    const u = await make([adapter], { store });
    const s = await u.sessions.create({ runtime: 'fake' });
    const a = await u.attachments.add(s.id, { name: 'a.md', mime: 'text/plain', body: bytes('a') });
    await expect(s.startRun({ prompt: 'p', attachmentIds: [a.id] })).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await s.snapshot()).runs).toEqual([]);
    expect((await s.get()).status).toBe('ready');
    expect(adapter.calls).toHaveLength(0);
  });

  it('startRun with foreign or unknown attachment id → invalid_request and no run', async () => {
    const adapter = fake();
    const u = await make([adapter]);
    const a = await u.sessions.create({ runtime: 'fake' });
    const b = await u.sessions.create({ runtime: 'fake' });
    const foreign = await u.attachments.add(b.id, { name: 'b.md', mime: 'text/plain', body: bytes('b') });
    const own = await u.attachments.add(a.id, { name: 'a.md', mime: 'text/plain', body: bytes('a') });

    for (const attachmentIds of [[foreign.id], ['att_unknown'], [own.id, foreign.id], [''], [own.id, own.id]]) {
      await expect(a.startRun({ prompt: 'p', attachmentIds })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect((await a.snapshot()).runs).toEqual([]);
    expect((await a.get()).status).toBe('ready');
    expect(adapter.calls).toHaveLength(0);
    // The own attachment was not consumed by the failed attempts.
    const run = await a.startRun({ prompt: 'p', attachmentIds: [own.id] });
    expect(run.attachments?.map((x) => x.id)).toEqual([own.id]);
  });

  it('startRun with already-referenced id → invalid_request', async () => {
    const u = await make([fake()]);
    const s = await u.sessions.create({ runtime: 'fake' });
    const att = await u.attachments.add(s.id, { name: 'a.md', mime: 'text/plain', body: bytes('a') });
    await s.startRun({ prompt: 'one', attachmentIds: [att.id] });
    await eventsUntil(s, isTerminal);
    await expect(s.startRun({ prompt: 'two', attachmentIds: [att.id] })).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await s.snapshot()).runs).toHaveLength(1);
  });

  it('adapter receives ResolvedAttachment with absPath', async () => {
    const adapter = fake();
    const u = await make([adapter]);
    const s = await u.sessions.create({ runtime: 'fake' });
    const img = await u.attachments.add(s.id, { name: 'shot.png', mime: 'image/png', body: bytes('png') });
    const doc = await u.attachments.add(s.id, { name: 'notes.md', mime: 'text/markdown', body: bytes('md') });
    const run = await s.startRun({ prompt: 'look', attachmentIds: [img.id, doc.id] });
    expect(run.attachments).toEqual([img, doc]);
    const events = await eventsUntil(s, isTerminal);
    const started = events.find((e) => e.type === 'run.started');
    expect(started?.type === 'run.started' && started.payload.run.attachments).toEqual([img, doc]);

    const received = adapter.calls[0]?.attachments ?? [];
    expect(received.map(publicAttachment)).toEqual([img, doc]);
    for (const r of received) {
      expect(r.absPath).toBe((await u.attachments.get(r.id)).absPath);
      expect(existsSync(r.absPath)).toBe(true);
    }
    // Persisted runs carry their attachments (snapshot after reload).
    const snap = await s.snapshot();
    expect(snap.runs[0]?.attachments).toEqual([img, doc]);
    expect((await u.runs.get(run.id)).attachments).toEqual([img, doc]);
  });

  it('keeps pick (attachmentIds) order end to end, including after reopen', async () => {
    const dataDir = join(dir, 'data');
    const adapter = fake();
    const u1 = await createUncage({ adapters: [adapter], dataDir, workspace: { allowedRoots: [dir], default: dir } });
    const s = await u1.sessions.create({ runtime: 'fake' });
    const b = await u1.attachments.add(s.id, { name: 'b.md', mime: 'text/plain', body: bytes('b') });
    await new Promise((r) => setTimeout(r, 5));
    const a = await u1.attachments.add(s.id, { name: 'a.md', mime: 'text/plain', body: bytes('a') });
    const run = await s.startRun({ prompt: 'p', attachmentIds: [a.id, b.id] });
    expect(run.attachments?.map((x) => x.id)).toEqual([a.id, b.id]);
    await eventsUntil(s, isTerminal);
    expect((adapter.calls[0]?.attachments ?? []).map((x) => x.id)).toEqual([a.id, b.id]);
    expect((await s.snapshot()).runs[0]?.attachments?.map((x) => x.id)).toEqual([a.id, b.id]);
    await u1.close();

    const u2 = await createUncage({ adapters: [fake()], dataDir, workspace: { allowedRoots: [dir], default: dir } });
    try {
      const snap = await (await u2.sessions.get(s.id)).snapshot();
      expect(snap.runs[0]?.attachments?.map((x) => x.id)).toEqual([a.id, b.id]);
      expect((await u2.runs.get(run.id)).attachments?.map((x) => x.id)).toEqual([a.id, b.id]);
    } finally {
      await u2.close();
    }
  });

  it('pruneOrphans deletes only unreferenced older than cutoff', async () => {
    const u = await make([fake()]);
    const s = await u.sessions.create({ runtime: 'fake' });
    const used = await u.attachments.add(s.id, { name: 'used.md', mime: 'text/plain', body: bytes('u') });
    const orphan = await u.attachments.add(s.id, { name: 'orphan.md', mime: 'text/plain', body: bytes('o') });
    await s.startRun({ prompt: 'p', attachmentIds: [used.id] });
    await eventsUntil(s, isTerminal);
    const usedPath = (await u.attachments.get(used.id)).absPath;
    const orphanPath = (await u.attachments.get(orphan.id)).absPath;

    // Cutoff before creation: nothing is old enough.
    expect(await u.attachments.pruneOrphans(new Date(Date.now() - 60_000))).toBe(0);
    expect(existsSync(orphanPath)).toBe(true);

    await new Promise((r) => setTimeout(r, 5));
    const fresh = await u.attachments.add(s.id, { name: 'fresh.md', mime: 'text/plain', body: bytes('f') });
    const cutoff = new Date(Date.parse(fresh.createdAt));
    // `fresh` was created at the cutoff, so it is not older than it.
    expect(await u.attachments.pruneOrphans(cutoff)).toBe(1);
    expect(existsSync(orphanPath)).toBe(false);
    expect(existsSync(usedPath)).toBe(true);
    await expect(u.attachments.get(orphan.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await u.attachments.get(fresh.id)).attachment.id).toBe(fresh.id);
    expect((await u.attachments.get(used.id)).attachment.id).toBe(used.id);
  });

  it('pruneOrphans sweeps abandoned .tmp-* uploads older than the cutoff', async () => {
    const u = await make([fake()]);
    const s = await u.sessions.create({ runtime: 'fake' });
    await u.attachments.add(s.id, { name: 'keep.md', mime: 'text/plain', body: bytes('k') });
    const old = join(attDir(s.id), '.tmp-att_old');
    const fresh = join(attDir(s.id), '.tmp-att_fresh');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'x');
    const twoDaysAgo = new Date(Date.now() - 48 * 3600_000);
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    await u.attachments.pruneOrphans(new Date(Date.now() - 24 * 3600_000));
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe('store attachments', () => {
  let store: Store;
  beforeEach(async () => {
    store = await openPgliteStore({ dataDir: 'memory://' });
  });
  afterEach(async () => {
    await store.close();
  });

  it('marks referenced only when unreferenced and deletes orphans', async () => {
    const base = { sessionId: 's1', mime: 'text/plain', size: 1, kind: 'file' as const, sha256: 'x' };
    await store.createAttachment({ ...base, id: 'a1', name: 'a', absPath: '/a', createdAt: '2026-01-01T00:00:00.000Z' });
    await store.createAttachment({ ...base, id: 'a2', name: 'b', absPath: '/b', createdAt: '2026-01-01T00:00:00.000Z' });
    // All or nothing: one unknown id marks nothing.
    expect(await store.markAttachmentsReferenced(['a1', 'missing'], 'run_0')).toBe(0);
    expect((await store.getAttachment('a1'))?.referencedByRun).toBeUndefined();
    expect(await store.markAttachmentsReferenced(['a1'], 'run_1')).toBe(1);
    expect(await store.markAttachmentsReferenced(['a1'], 'run_2')).toBe(0);
    expect((await store.getAttachment('a1'))?.referencedByRun).toBe('run_1');
    expect((await store.listAttachments(['a1', 'a2', 'zz'])).map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    expect(await store.markAttachmentsReferenced(['a2', 'a2'], 'run_8')).toBe(0);
    expect(await store.markAttachmentsReferenced(['a2'], 'run_9')).toBe(1);
    await store.releaseAttachments('run_9');
    expect((await store.getAttachment('a2'))?.referencedByRun).toBeUndefined();
    const rows = await store.deleteOrphanAttachments(new Date('2026-06-01T00:00:00.000Z'));
    expect(rows.map((r) => r.absPath)).toEqual(['/b']);
    expect(await store.getAttachment('a2')).toBeNull();
  });

  it('released attachments can be re-sent in a different order', async () => {
    const base = { sessionId: 's1', mime: 'text/plain', size: 1, kind: 'file' as const, sha256: 'x', createdAt: '2026-01-01T00:00:00.000Z' };
    for (const id of ['x1', 'x2', 'x3']) await store.createAttachment({ ...base, id, name: id, absPath: `/${id}` });
    expect(await store.markAttachmentsReferenced(['x3', 'x1', 'x2'], 'run_a')).toBe(3);
    await store.releaseAttachments('run_a');
    expect(await store.markAttachmentsReferenced(['x2', 'x3', 'x1'], 'run_b')).toBe(3);
    await store.createRun({ id: 'run_b', sessionId: 's1', prompt: 'p', state: 'queued', createdAt: new Date().toISOString() });
    expect((await store.getRun('run_b'))?.attachments?.map((a) => a.id)).toEqual(['x2', 'x3', 'x1']);
  });
});
