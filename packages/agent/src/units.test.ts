import { appendFile, link, chmod, mkdir, mkdtemp, readFile, rename, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AgentFrame } from '@uncage/protocol';
import { join } from 'node:path';
import type { DeviceCodeResponse } from '@uncage/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { agentConfigLockPath, agentConfigPath, agentDir, ensureAgentDir, loadAgentConfig, newMachineKey, updateAgentSites, withAgentConfigLock } from './config.js';
import { fitEvent, TRUNCATED_EXTENSION } from './fit.js';
import { EventEnvelopeSchemas, UncageEventSchema, type UncageEvent } from '@uncage/protocol';
import { utimes } from 'node:fs/promises';
import { agentWsUrl, normalizeHubUrl, pollDeviceToken, requestDeviceCode } from './device.js';
import { MAX_PULL_FILE_BYTES, planPull, sendPull } from './files.js';
import { backoffDelay, siteHost } from './site.js';
import { startTestHub, tmpHome } from './test-helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});
const home = async () => {
  const h = await tmpHome();
  cleanups.push(h.cleanup);
  return h.home;
};

describe('normalizeHubUrl / agentWsUrl', () => {
  it('appends /api/uncage when the URL has no path, keeps an explicit path', () => {
    expect(normalizeHubUrl('https://app.example.com')).toBe('https://app.example.com/api/uncage');
    expect(normalizeHubUrl('https://app.example.com/')).toBe('https://app.example.com/api/uncage');
    expect(normalizeHubUrl('app.example.com')).toBe('https://app.example.com/api/uncage');
    expect(normalizeHubUrl('https://app.example.com/hub/')).toBe('https://app.example.com/hub');
    expect(normalizeHubUrl('http://localhost:3000')).toBe('http://localhost:3000/api/uncage');
  });
  it('refuses plain http to non-loopback hosts, other schemes and credentials', () => {
    expect(() => normalizeHubUrl('http://app.example.com')).toThrow(/https/);
    expect(() => normalizeHubUrl('ftp://x.com')).toThrow();
    expect(() => normalizeHubUrl('https://u:p@x.com')).toThrow(/credentials/);
  });
  it('maps to wss (ws only for loopback)', () => {
    expect(agentWsUrl('https://app.example.com/api/uncage')).toBe('wss://app.example.com/api/uncage/agent');
    expect(agentWsUrl('http://127.0.0.1:8080/api/uncage')).toBe('ws://127.0.0.1:8080/api/uncage/agent');
    expect(() => agentWsUrl('http://evil.example.com/api/uncage')).toThrow(/insecure/);
    expect(() => agentWsUrl('ftp://app.example.com/api/uncage')).toThrow(/non-http/);
    expect(() => agentWsUrl('ws://evil.example.com/api/uncage')).toThrow(/non-http/);
    expect(() => agentWsUrl('file:///etc/passwd')).toThrow(/non-http/);
  });
  it('siteHost is filesystem-safe', () => {
    expect(siteHost('https://App.Example.com/api/uncage')).toBe('app.example.com');
    expect(siteHost('http://127.0.0.1:8080/x')).toBe('127.0.0.1-8080');
    expect(() => siteHost('https://./x')).toThrow(/workspace folder/);
    expect(() => siteHost('https://.../x')).toThrow(/workspace folder/);
  });
});

describe('backoffDelay', () => {
  const t = { backoffMinMs: 1000, backoffMaxMs: 30_000 };
  it('doubles from 1 s to a 30 s cap, jittered within [base/2, base]', () => {
    expect(backoffDelay(0, t, () => 1)).toBe(1000);
    expect(backoffDelay(0, t, () => 0)).toBe(500);
    expect(backoffDelay(3, t, () => 1)).toBe(8000);
    expect(backoffDelay(10, t, () => 1)).toBe(30_000);
    expect(backoffDelay(99, t, () => 0)).toBe(15_000);
  });
});

describe('agent config', () => {
  const site = { id: 'app.example.com', name: 'App', url: 'https://app.example.com/api/uncage', machineId: 'mch_1', token: 'secret-token' };

  it('missing file → no sites, bypass off', async () => {
    expect(await loadAgentConfig(await home())).toEqual({ sites: [], localPolicy: { allowBypass: false } });
  });

  it('round-trips sites, preserves hand-written localPolicy and comments, writes 0600', async () => {
    const h = await home();
    await mkdir(join(h, '.uncage'), { recursive: true });
    await writeFile(agentConfigPath(h), '# my notes\nlocalPolicy:\n  allowBypass: true # yes really\n  allowedPermissionModes: [default, acceptEdits]\n');
    const key = newMachineKey();
    await updateAgentSites(h, () => [{ ...site, machineKey: key }]);
    const raw = await readFile(agentConfigPath(h), 'utf8');
    expect(raw).toContain('# my notes');
    expect(raw).toContain('# yes really');
    expect(((await stat(agentConfigPath(h))).mode & 0o777).toString(8)).toBe('600');
    expect(await loadAgentConfig(h)).toEqual({
      sites: [{ ...site, machineKey: key }],
      localPolicy: { allowBypass: true, allowedPermissionModes: ['default', 'acceptEdits'] },
    });
  });

  it('tightens a group/world-readable file to 0600 on load', async () => {
    const h = await home();
    await updateAgentSites(h, () => [site]);
    await chmod(agentConfigPath(h), 0o644);
    await loadAgentConfig(h);
    expect(((await stat(agentConfigPath(h))).mode & 0o777).toString(8)).toBe('600');
  });

  it('rejects unsafe site ids, unknown keys and bad modes', async () => {
    const h = await home();
    await expect(updateAgentSites(h, () => [{ ...site, id: '../etc' }])).rejects.toThrow();
    await mkdir(join(h, '.uncage'), { recursive: true });
    await writeFile(agentConfigPath(h), 'localPolicy:\n  allowBypas: true\n');
    await expect(loadAgentConfig(h)).rejects.toThrow(/Invalid/);
    await writeFile(agentConfigPath(h), 'localPolicy:\n  allowedPermissionModes: [yolo]\n');
    await expect(loadAgentConfig(h)).rejects.toThrow(/allowedPermissionModes/);
  });

  it('tightens an existing ~/.uncage to 0700', async () => {
    const h = await home();
    await mkdir(agentDir(h), { mode: 0o755 });
    await chmod(agentDir(h), 0o755);
    await ensureAgentDir(h);
    expect(((await stat(agentDir(h))).mode & 0o777).toString(8)).toBe('700');
    await chmod(agentDir(h), 0o755);
    await updateAgentSites(h, () => []);
    expect(((await stat(agentDir(h))).mode & 0o777).toString(8)).toBe('700');
  });

  it('serializes concurrent read-modify-writes with agent.yaml.lock (no lost updates)', async () => {
    const h = await home();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        updateAgentSites(h, (sites) => [...sites, { ...site, id: `s${i}.example`, url: `https://s${i}.example/api/uncage` }]),
      ),
    );
    expect((await loadAgentConfig(h)).sites.map((s) => s.id).sort()).toHaveLength(12);
    await expect(stat(agentConfigLockPath(h))).rejects.toThrow();
  });

  it('waits for a fresh lock and breaks a stale one (> 10 s)', async () => {
    const h = await home();
    await ensureAgentDir(h);
    await writeFile(agentConfigLockPath(h), 'other');
    let done = false;
    const p = updateAgentSites(h, () => [site]).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 150));
    expect(done).toBe(false);
    const { unlink } = await import('node:fs/promises');
    await unlink(agentConfigLockPath(h));
    await p;
    expect(done).toBe(true);

    await writeFile(agentConfigLockPath(h), 'crashed');
    const old = new Date(Date.now() - 11_000);
    await utimes(agentConfigLockPath(h), old, old);
    await updateAgentSites(h, () => []);
    expect((await loadAgentConfig(h)).sites).toEqual([]);
  });

  it('writes a unique token into the lock and only removes a lock that still holds it', async () => {
    const h = await home();
    await withAgentConfigLock(h, async () => {
      expect(await readFile(agentConfigLockPath(h), 'utf8')).toMatch(/^\d+ [0-9a-f]{24} /);
      // Our lock was broken as stale and another process took it.
      await writeFile(agentConfigLockPath(h), 'someone else');
    });
    expect(await readFile(agentConfigLockPath(h), 'utf8')).toBe('someone else');
  });

  it('machine keys are 32 random bytes, base64url', () => {
    const k = newMachineKey();
    expect(k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(k, 'base64url')).toHaveLength(32);
    expect(newMachineKey()).not.toBe(k);
  });
});

describe('device flow client', () => {
  it('pairs against a real hub with programmatic approval, sending the machineKey', async () => {
    const t = await startTestHub();
    cleanups.push(() => t.close());
    const key = newMachineKey();
    const code = await requestDeviceCode(fetch, t.api, { name: 'Mac', os: 'darwin', machineKey: key });
    expect(code.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const polling = pollDeviceToken({ fetch, hubUrl: t.api, code: { ...code, intervalSec: 1 } });
    await new Promise((r) => setTimeout(r, 200));
    expect(await t.hub.approveDevice(code.userCode, { id: 'alice' })).toBe('ok');
    const grant = await polling;
    expect(grant).toMatchObject({ status: 'ok', site: { url: t.api } });
    // Re-pairing with the same key keeps the machine id.
    const code2 = await requestDeviceCode(fetch, t.api, { machineKey: key });
    await t.hub.approveDevice(code2.userCode, { id: 'alice' });
    const grant2 = await pollDeviceToken({ fetch, hubUrl: t.api, code: { ...code2, intervalSec: 1 } });
    expect(grant2.machineId).toBe(grant.machineId);
    expect(grant2.machineToken).not.toBe(grant.machineToken);
  }, 15_000);

  const code: DeviceCodeResponse = { deviceCode: 'd', userCode: 'ABCD-EFGH', verificationUri: 'https://x/device', intervalSec: 2, expiresInSec: 600 };
  const scripted = (statuses: unknown[]) => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(statuses.shift()), { status: 200 });
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it('honours slow_down (+5 s) and keeps polling on pending', async () => {
    const waits: number[] = [];
    const { f } = scripted([{ status: 'pending' }, { status: 'slow_down' }, { status: 'ok', machineId: 'm', machineToken: 't', site: { id: 's', name: 's', url: 'https://x/api/uncage' } }]);
    const g = await pollDeviceToken({ fetch: f, hubUrl: 'https://x/api/uncage', code, sleep: async (ms) => void waits.push(ms) });
    expect(g.machineId).toBe('m');
    expect(waits).toEqual([2000, 2000, 7000]);
  });

  it('denied and expired end with clear errors', async () => {
    await expect(pollDeviceToken({ fetch: scripted([{ status: 'denied' }]).f, hubUrl: 'https://x', code, sleep: async () => undefined })).rejects.toThrow(/denied/);
    await expect(pollDeviceToken({ fetch: scripted([{ status: 'expired' }]).f, hubUrl: 'https://x', code, sleep: async () => undefined })).rejects.toThrow(/expired/);
  });
});

describe('planPull fence', () => {
  it('rejects traversal and absolute paths even if the frame schema were bypassed', async () => {
    const h = await home();
    await expect(planPull(h, '../etc/hosts', 100)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(planPull(h, '/etc/hosts', 100)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(planPull(h, 'a/../../x', 100)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('caps the total at 50 MiB even when maxBytes asks for more', async () => {
    const h = await home();
    await writeFile(join(h, 'f.txt'), 'abc');
    const plan = await planPull(h, 'f.txt', 10 ** 12);
    expect(plan.files.map((f) => f.rel)).toEqual(['f.txt']);
    expect(plan.limit).toBe(50 * 1024 * 1024);
  });
});

describe('sendPull re-checks at send time', () => {
  const collect = () => {
    const frames: AgentFrame[] = [];
    return { frames, send: async (f: AgentFrame) => void frames.push(f) };
  };

  it('a file that grows past the total cap between plan and send is refused', async () => {
    const h = await home();
    await writeFile(join(h, 'a.bin'), Buffer.alloc(600));
    const plan = await planPull(h, 'a.bin', 1000);
    await appendFile(join(h, 'a.bin'), Buffer.alloc(900));
    const c = collect();
    await expect(sendPull('p', plan, c.send)).rejects.toMatchObject({ code: 'invalid_request', details: { maxBytes: 1000 } });
    expect(c.frames.filter((f) => f.t === 'file_chunk')).toEqual([]);
  });

  it('a file that grows past 10 MiB between plan and send is refused', async () => {
    const h = await home();
    await writeFile(join(h, 'a.bin'), 'x');
    const plan = await planPull(h, 'a.bin', 50 * 1024 * 1024);
    await truncate(join(h, 'a.bin'), MAX_PULL_FILE_BYTES + 1);
    await expect(sendPull('p', plan, collect().send)).rejects.toMatchObject({ details: { maxFileBytes: MAX_PULL_FILE_BYTES } });
  });

  it('a file that grows within the caps is sent up to its size at open, never more', async () => {
    const h = await home();
    await writeFile(join(h, 'a.txt'), 'abc');
    const plan = await planPull(h, 'a.txt', 1000);
    await appendFile(join(h, 'a.txt'), 'def');
    const c = collect();
    await sendPull('p', plan, c.send);
    expect(c.frames.at(-1)).toEqual({ t: 'file_done', id: 'p', files: [{ path: 'a.txt', size: 6 }] });
  });

  it('an intermediate directory swapped for a symlink to an outside directory is refused', async () => {
    const h = await home();
    const outside = await mkdtemp(join(tmpdir(), 'uncage-outside-'));
    cleanups.push(() => import('node:fs/promises').then((f) => f.rm(outside, { recursive: true, force: true })));
    await mkdir(join(h, 'site'));
    await writeFile(join(h, 'site', 'a.txt'), 'inside');
    await writeFile(join(outside, 'a.txt'), 'SECRET');
    const plan = await planPull(h, 'site', 1000);
    await rename(join(h, 'site'), join(h, 'site.old'));
    await symlink(outside, join(h, 'site'));
    const c = collect();
    await expect(sendPull('p', plan, c.send)).rejects.toMatchObject({ message: expect.stringContaining('changed') });
    expect(JSON.stringify(c.frames)).not.toContain(Buffer.from('SECRET').toString('base64'));
  });

  it('refuses hard-linked files at plan time (a hard link may point outside the workspace)', async () => {
    const h = await home();
    const outside = await mkdtemp(join(tmpdir(), 'uncage-outside-'));
    cleanups.push(() => import('node:fs/promises').then((f) => f.rm(outside, { recursive: true, force: true })));
    await writeFile(join(outside, 'secret.txt'), 'SECRET');
    await mkdir(join(h, 'site'));
    await link(join(outside, 'secret.txt'), join(h, 'site', 'innocent.txt'));
    await expect(planPull(h, 'site', 1000)).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('hard link') });
  });

  it('refuses a file hard-linked between plan and send', async () => {
    const h = await home();
    await writeFile(join(h, 'a.txt'), 'abc');
    const plan = await planPull(h, 'a.txt', 1000);
    await link(join(h, 'a.txt'), join(h, 'b.txt'));
    await expect(sendPull('p', plan, collect().send)).rejects.toMatchObject({ message: expect.stringContaining('hard link') });
  });

  it('the planned directory moved out of the workspace (same inode, now outside) is refused', async () => {
    const h = await home();
    const outside = await mkdtemp(join(tmpdir(), 'uncage-outside-'));
    cleanups.push(() => import('node:fs/promises').then((f) => f.rm(outside, { recursive: true, force: true })));
    await mkdir(join(h, 'site'));
    await writeFile(join(h, 'site', 'a.txt'), 'inside');
    const plan = await planPull(h, 'site', 1000);
    await rename(join(h, 'site'), join(outside, 'site'));
    await symlink(join(outside, 'site'), join(h, 'site'));
    await expect(sendPull('p', plan, collect().send)).rejects.toMatchObject({ message: expect.stringContaining('changed') });
  });
});

describe('fitEvent', () => {
  const ev = (text: string) =>
    ({ eventId: 'evt_0000000001', sequence: 1, sessionId: 'ses_1', runId: 'run_1', type: 'message.completed', occurredAt: 'x', schemaVersion: '1.0', payload: { messageId: 'msg_1', text } }) as never;
  it('returns small events unchanged', () => {
    const e = ev('hi');
    expect(fitEvent(e, 10_000)).toBe(e);
  });
  it('truncates the largest string fields with a marker until the event fits', () => {
    const e = ev('é'.repeat(300_000)); // 600 000 bytes
    const fitted = fitEvent(e, 100_000) as { sequence: number; payload: { text: string; messageId: string } };
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(100_000);
    expect(fitted.sequence).toBe(1);
    expect(fitted.payload.messageId).toBe('msg_1');
    expect(fitted.payload.text).toMatch(/…\[truncated \d+ bytes\]$/);
    expect(fitted.payload.text.startsWith('éé')).toBe(true);
    expect((e as { payload: { text: string } }).payload.text).toHaveLength(300_000); // original untouched
  });
});

describe('fitEvent fallbacks', () => {
  const env = (type: string, payload: unknown) =>
    ({ eventId: 'evt_0000000007', sequence: 7, sessionId: 'ses_1', runId: 'run_1', type, occurredAt: '2026-11-07T00:00:00Z', schemaVersion: '1.0', payload }) as unknown as UncageEvent;
  const BUDGET = 100_000;
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const valid = (e: UncageEvent) => expect(UncageEventSchema.safeParse(e).success).toBe(true);

  it('never makes an event bigger: many short strings fall back to a stub that fits', () => {
    const input = { words: Array.from({ length: 80_000 }, (_, i) => `w${i % 10}`) };
    const e = env('tool.started', { toolId: 'tool_1', name: 'Bash', title: 'run', category: 'shell', input });
    const before = size(e);
    const f = fitEvent(e, BUDGET);
    expect(size(f)).toBeLessThanOrEqual(BUDGET);
    expect(size(f)).toBeLessThan(before);
    expect(f).toMatchObject({ sequence: 7, type: 'tool.started', payload: { toolId: 'tool_1', category: 'shell' } });
    expect((f as { extensions?: Record<string, unknown> }).extensions?.[TRUNCATED_EXTENSION]).toEqual({ originalBytes: before });
    valid(f);
  });

  it('a numbers-heavy payload falls back to a schema-valid stub keeping the ids', () => {
    const big = Array.from({ length: 200_000 }, (_, i) => i * 1.5);
    for (const [type, payload, ids] of [
      ['tool.completed', { toolId: 'tool_9', output: JSON.stringify(big).slice(0, 10), durationMs: 5, extra: big }, { toolId: 'tool_9' }],
      ['run.failed', { runId: 'run_1', error: { code: 'internal_error', message: 'x', retryable: false, details: { big } } }, { runId: 'run_1' }],
    ] as const) {
      const f = fitEvent(env(type, payload), BUDGET);
      expect(size(f)).toBeLessThanOrEqual(BUDGET);
      expect(f.payload).toMatchObject(ids);
      expect(EventEnvelopeSchemas[type].safeParse(f).success).toBe(true);
    }
  });

  it('a session event with huge arrays keeps the session (ids, state) with arrays shortened', () => {
    const models = Array.from({ length: 50_000 }, (_, i) => ({ id: `m${i}`, label: `Model ${i}` }));
    const session = {
      id: 'ses_1', runtimeId: 'fake', workspace: '/w', title: 't', status: 'ready', readOnly: false, createdAt: '2026-11-07T00:00:00Z',
      capabilities: { streaming: true, approval: { once: true, session: false, types: [] }, nativeResume: false, diffEvents: false, mcp: false, skills: 'unknown', siteTools: true, models, efforts: [], permissionModes: ['default'], attachments: { images: false, files: false, maxBytes: 1 } },
      settings: { permissionMode: 'default' },
    };
    const f = fitEvent(env('session.updated', { session }), BUDGET);
    expect(size(f)).toBeLessThanOrEqual(BUDGET);
    expect(f.payload).toMatchObject({ session: { id: 'ses_1', status: 'ready' } });
    valid(f);
  });

  it('a top-level string payload is truncated too', () => {
    const f = fitEvent(env('message.completed', 'q'.repeat(300_000)) as UncageEvent, BUDGET) as unknown as { payload: string };
    expect(size(f)).toBeLessThanOrEqual(BUDGET);
    expect(f.payload).toMatch(/…\[truncated \d+ bytes\]$/);
  });
});
