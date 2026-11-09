import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentConfig, updateAgentSites, type ExecFn } from '@uncage/agent';
import { createHub, type Hub } from '@uncage/hub';
import { pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIALOG_TIMEOUT_S } from './confirm-dialog.js';
import { LOCK_MAX_AGE_MS, parseConnectLink, runConnect, takeLock } from './connect.js';
import type { AgentService } from './service/index.js';
import type { SiteIdentity } from './site-identity.js';

const link = (u: string) => `uncage://connect?url=${encodeURIComponent(u)}`;

describe('parseConnectLink', () => {
  it('accepts uncage://connect?url=<site> and a bare https URL', () => {
    expect(parseConnectLink(link('https://app.example.com'))).toEqual({ url: 'https://app.example.com/api/uncage' });
    expect(parseConnectLink(link('https://app.example.com/api/uncage'))).toEqual({ url: 'https://app.example.com/api/uncage' });
    expect(parseConnectLink('UNCAGE://connect/?url=https%3A%2F%2Fexample.com%2Fhub')).toEqual({ url: 'https://example.com/hub' });
    expect(parseConnectLink('https://example.com')).toEqual({ url: 'https://example.com/api/uncage' });
    expect(parseConnectLink('  https://example.com/x/  ')).toEqual({ url: 'https://example.com/x' });
    expect(parseConnectLink('example.com')).toEqual({ url: 'https://example.com/api/uncage' });
  });

  it('accepts plain http only for loopback', () => {
    expect(parseConnectLink(link('http://localhost:3000'))).toEqual({ url: 'http://localhost:3000/api/uncage' });
    expect(parseConnectLink(link('http://127.0.0.1:3000/api/uncage'))).toEqual({ url: 'http://127.0.0.1:3000/api/uncage' });
    expect(parseConnectLink('http://[::1]:3000')).toEqual({ url: 'http://[::1]:3000/api/uncage' });
    expect(parseConnectLink('localhost:3000')).toEqual({ url: 'https://localhost:3000/api/uncage' });
  });

  it.each([
    ['javascript: link', 'javascript:alert(1)'],
    ['javascript: inside the link', link('javascript:alert(1)')],
    ['data: inside the link', link('data:text/html,<script>1</script>')],
    ['file: inside the link', link('file:///etc/passwd')],
    ['http non-loopback', link('http://evil.com')],
    ['bare http non-loopback', 'http://evil.com'],
    ['http to a loopback-looking name', link('http://localhost.evil.com')],
    ['credentials', link('https://user:pw@x.com')],
    ['user only', 'https://user@x.com'],
    ['>2048', link(`https://example.com/${'a'.repeat(2100)}`)],
    ['>2048 bare', `https://example.com/${'a'.repeat(2048)}`],
    ['fragment-only junk', 'uncage://connect#https://example.com'],
    ['a fragment in the site URL', link('https://example.com/#x')],
    ['a query in the site URL', link('https://example.com/?next=https://evil.com')],
    ['a fragment on the link', `${link('https://example.com')}#x`],
    ['extra params', `${link('https://example.com')}&name=Example`],
    ['two url params', `${link('https://example.com')}&url=${encodeURIComponent('https://evil.com')}`],
    ['no url param', 'uncage://connect'],
    ['empty url param', 'uncage://connect?url='],
    ['another action', link('https://example.com').replace('connect', 'disconnect')],
    ['a path after connect', 'uncage://connect/evil?url=https%3A%2F%2Fexample.com'],
    ['credentials on the link', 'uncage://me@connect?url=https%3A%2F%2Fexample.com'],
    ['a nested uncage link', link(link('https://example.com'))],
    ['control characters', link('https://exa\nmple.com')],
    ['whitespace inside', link('https://exa mple.com')],
    ['a host ending in a dot', link('https://example.com./')],
    ['empty', ''],
    ['not a URL', 'https://'],
  ])('refuses %s', (_name, raw) => {
    const r = parseConnectLink(raw);
    expect(r).toEqual({ error: expect.any(String) });
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

async function tmpHome(): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), 'uncage-connect-'));
  cleanups.push(() => rm(h, { recursive: true, force: true }));
  return h;
}

async function startHub(): Promise<{ hub: Hub; origin: string }> {
  const store = await pgliteHubStore({ dataDir: 'memory://' });
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = await createHub({ publicUrl: origin, store, getUser: async (req) => (req.headers.get('x-user') ? { id: req.headers.get('x-user')! } : null) });
  const node = toNodeHandler(hub);
  server.on('request', (req, res) => node(req, res));
  cleanups.push(async () => {
    await hub.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
  });
  return { hub, origin };
}

const fakeService = (restarted: boolean) => {
  const restart = vi.fn(async () => restarted);
  const service = { kind: restarted ? 'launchd' : 'none', install: vi.fn(), uninstall: vi.fn(), status: vi.fn(), restart } as unknown as AgentService;
  return { service, restart };
};
const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50)));

/** A scripted hub: `/device/code` and `/device/token` answers (anything else 404). */
function fakeHub(o: { verificationUri: string; siteUrl: string }) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/device/code')) return json({ deviceCode: 'd', userCode: 'ABCD-EFGH', verificationUri: o.verificationUri, intervalSec: 0, expiresInSec: 60 });
    if (url.endsWith('/device/token')) {
      return json({ status: 'ok', machineId: 'm1', machineToken: 'tok', site: { id: 's1', name: 'Site', url: o.siteUrl }, transports: [{ kind: 'http', url: `${o.siteUrl}/agent` }] });
    }
    return new Response('{}', { status: 404 });
  });
}

describe('uncage connect: the confirmed hub URL is the one paired with', () => {
  const hubUrl = 'https://script.google.com/macros/s/AKfycbX/exec';

  it('a script.google.com/macros/... link shows the full URL with a path warning', async () => {
    const confirm = vi.fn<(i: SiteIdentity) => Promise<boolean>>(async () => false);
    expect(await runConnect({ link: link(hubUrl), home: await tmpHome(), fetch: vi.fn<typeof fetch>(), exec: vi.fn<ExecFn>(), out: () => undefined, confirm })).toBe(1);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ url: hubUrl, registrableDomain: 'google.com', warnings: ['path', 'first_time'] }));
  });

  it('pairs with exactly that URL and saves it', async () => {
    const home = await tmpHome();
    const fetchSpy = fakeHub({ verificationUri: 'https://script.google.com/macros/s/AKfycbX/exec/device?code=ABCD-EFGH', siteUrl: hubUrl });
    const code = await runConnect({ link: link(hubUrl), home, fetch: fetchSpy, exec: vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' })), out: () => undefined, confirm: async () => true, service: null, noBrowser: true, sleep: fastSleep });
    expect(code).toBe(0);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${hubUrl}/device/code`);
    expect((await loadAgentConfig(home)).sites.map((s) => s.url)).toEqual([hubUrl]);
  });

  it('refuses (nothing saved) when the hub answers with another hub URL on the same origin', async () => {
    const home = await tmpHome();
    const fetchSpy = fakeHub({ verificationUri: 'https://script.google.com/device?code=ABCD-EFGH', siteUrl: 'https://script.google.com/macros/s/OTHER/exec' });
    await expect(
      runConnect({ link: link(hubUrl), home, fetch: fetchSpy, exec: vi.fn<ExecFn>(), out: () => undefined, confirm: async () => true, service: null, noBrowser: true, sleep: fastSleep }),
    ).rejects.toThrow(/not .*you confirmed/i);
    expect((await loadAgentConfig(home)).sites).toEqual([]);
  });

  it('refuses before opening anything when the approval page is on another origin', async () => {
    const home = await tmpHome();
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' }));
    const fetchSpy = fakeHub({ verificationUri: 'https://evil.example/device?code=ABCD-EFGH', siteUrl: 'https://example.com/api/uncage' });
    const lines: string[] = [];
    await expect(
      runConnect({ link: link('https://example.com'), home, fetch: fetchSpy, exec, out: (l) => lines.push(l), confirm: async () => true, service: null, sleep: fastSleep }),
    ).rejects.toThrow(/approval page/i);
    expect(exec).not.toHaveBeenCalled(); // no browser opened on evil.example
    expect(lines.join('\n')).not.toContain('evil.example');
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(['https://example.com/api/uncage/device/code']); // never polled
  });
});

describe('uncage connect: one at a time', () => {
  it('a second connect exits 1 while one is asking; the lock is released afterwards', async () => {
    const home = await tmpHome();
    let release!: (v: boolean) => void;
    const first = runConnect({
      link: link('https://example.com'),
      home,
      fetch: vi.fn<typeof fetch>(),
      exec: vi.fn<ExecFn>(),
      out: () => undefined,
      confirm: () => new Promise<boolean>((r) => (release = r)),
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const confirm2 = vi.fn(async () => true);
    const lines: string[] = [];
    expect(await runConnect({ link: link('https://example.com'), home, fetch: vi.fn<typeof fetch>(), exec: vi.fn<ExecFn>(), out: (l) => lines.push(l), confirm: confirm2 })).toBe(1);
    expect(confirm2).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/already asking/i);
    release(false);
    expect(await first).toBe(1);
    const confirm3 = vi.fn(async () => false);
    expect(await runConnect({ link: link('https://example.com'), home, fetch: vi.fn<typeof fetch>(), exec: vi.fn<ExecFn>(), out: () => undefined, confirm: confirm3 })).toBe(1);
    expect(confirm3).toHaveBeenCalledTimes(1); // lock released
  });

  it('a lock whose PID is gone is stale and taken over; a live PID keeps it for the longest dialog + margin', async () => {
    const home = await tmpHome();
    await mkdir(join(home, '.uncage'), { recursive: true });
    const lock = join(home, '.uncage', 'connect.lock');
    const run = async () => {
      const confirm = vi.fn(async () => false);
      await runConnect({ link: link('https://example.com'), home, fetch: vi.fn<typeof fetch>(), exec: vi.fn<ExecFn>(), out: () => undefined, confirm });
      return confirm.mock.calls.length;
    };
    // A dead PID (legacy "<pid> <time>" format): stale at once.
    await writeFile(lock, '999999999 2026-11-09T00:00:00.000Z\n');
    expect(await run()).toBe(1);
    // A live PID, 3 minutes old (a dialog still open): kept.
    await writeFile(lock, `${process.pid} ${new Date().toISOString()} other-token\n`);
    const three = new Date(Date.now() - 3 * 60_000);
    await utimes(lock, three, three);
    expect(await run()).toBe(0);
    // A live PID older than the longest dialog + margin (a reused PID): stale.
    expect(LOCK_MAX_AGE_MS).toBeGreaterThan(DIALOG_TIMEOUT_S * 1000);
    const old = new Date(Date.now() - LOCK_MAX_AGE_MS - 1000);
    await utimes(lock, old, old);
    expect(await run()).toBe(1);
  });

  it('release only deletes our own lock', async () => {
    const home = await tmpHome();
    const lock = join(home, '.uncage', 'connect.lock');
    const mine = await takeLock(lock);
    expect(mine).not.toBeNull();
    expect(await readFile(lock, 'utf8')).toMatch(new RegExp(`^${process.pid} \\S+ [A-Za-z0-9_-]{22,}\\n$`));
    // Another run took the lock over meanwhile (e.g. ours was judged stale).
    await writeFile(lock, `${process.pid} ${new Date().toISOString()} someone-else\n`);
    await mine!.release();
    expect(await readFile(lock, 'utf8')).toContain('someone-else');
  });

  it('two runs taking over the same stale lock: exactly one wins', async () => {
    const home = await tmpHome();
    await mkdir(join(home, '.uncage'), { recursive: true });
    const lock = join(home, '.uncage', 'connect.lock');
    for (let i = 0; i < 20; i++) {
      await writeFile(lock, '999999999 2026-11-09T00:00:00.000Z\n');
      const got = await Promise.all([takeLock(lock), takeLock(lock), takeLock(lock)]);
      expect(got.filter(Boolean)).toHaveLength(1);
      await got.find(Boolean)!.release();
      await expect(stat(lock)).rejects.toThrow();
    }
    expect((await readdir(join(home, '.uncage'))).filter((f) => f.startsWith('connect.lock'))).toEqual([]);
  });
});

describe('uncage connect', () => {
  it('skips odd site URLs in agent.yaml (no host) instead of crashing or matching everything', async () => {
    const home = await tmpHome();
    await updateAgentSites(home, () => [
      { id: 's0', name: 'Broken', url: 'mailto:someone', machineId: 'm0', token: 't', machineKey: 'k'.repeat(43) },
      { id: 's1', name: 'Example', url: 'https://example.com/api/uncage', machineId: 'm1', token: 't', machineKey: 'k'.repeat(43) },
    ]);
    const confirm = vi.fn<(i: SiteIdentity) => Promise<boolean>>(async () => false);
    expect(await runConnect({ link: link('https://example.com'), home, fetch: vi.fn<typeof fetch>(), exec: vi.fn<ExecFn>(), out: () => undefined, confirm })).toBe(1);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ warnings: [] }));
  });

  it('exits 2 on a bad link without asking or fetching', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const confirm = vi.fn(async () => true);
    const lines: string[] = [];
    const code = await runConnect({ link: link('http://evil.com'), home: await tmpHome(), fetch: fetchSpy, exec: vi.fn<ExecFn>(), out: (l) => lines.push(l), confirm });
    expect(code).toBe(2);
    expect(confirm).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/http/i);
  });

  it('never starts a device flow when the dialog is cancelled', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' }));
    const confirm = vi.fn<(i: SiteIdentity) => Promise<boolean>>(async () => false);
    const { service, restart } = fakeService(true);
    const lines: string[] = [];
    const code = await runConnect({ link: link('https://example.com'), home: await tmpHome(), fetch: fetchSpy, exec, out: (l) => lines.push(l), confirm, service });
    expect(code).toBe(1);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ registrableDomain: 'example.com', origin: 'https://example.com', warnings: ['first_time'] }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled(); // no browser opened
    expect(restart).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/not connected/i);
  });

  it('known = registrable domains of the sites in agent.yaml (lookalike + first time warnings reach the dialog)', async () => {
    const home = await tmpHome();
    await updateAgentSites(home, () => [{ id: 's1', name: 'Example', url: 'https://app.example.com/api/uncage', machineId: 'm1', token: 't', machineKey: 'k'.repeat(43) }]);
    const confirm = vi.fn<(i: SiteIdentity) => Promise<boolean>>(async () => false);
    await runConnect({ link: link('https://examp1e.com'), home, fetch: vi.fn<typeof fetch>(), exec: vi.fn<ExecFn>(), out: () => undefined, confirm });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ registrableDomain: 'examp1e.com', warnings: ['first_time', 'lookalike'], lookalikeOf: 'example.com' }));
    confirm.mockClear();
    await runConnect({ link: link('https://other.example.com'), home, fetch: vi.fn<typeof fetch>(), exec: vi.fn<ExecFn>(), out: () => undefined, confirm });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ warnings: [] }));
  });

  it('a failing dialog counts as cancelled (fail closed)', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const confirm = vi.fn(async () => {
      throw new Error('no display');
    });
    const code = await runConnect({ link: link('https://example.com'), home: await tmpHome(), fetch: fetchSpy, exec: vi.fn<ExecFn>(), out: () => undefined, confirm });
    expect(code).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the default dialog refuses when nothing can ask (no GUI, no TTY): no flow', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const exec = vi.fn<ExecFn>();
    const lines: string[] = [];
    const code = await runConnect({
      link: link('https://example.com'),
      home: await tmpHome(),
      fetch: fetchSpy,
      exec,
      out: (l) => lines.push(l),
      platform: 'freebsd',
      isTTY: false,
      env: {},
    });
    expect(code).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/could not ask/i);
  });

  it('pairs against a real test hub after confirm, opens /device?code= and restarts the service', async () => {
    const { hub, origin } = await startHub();
    const home = await tmpHome();
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' }));
    const { service, restart } = fakeService(true);
    const lines: string[] = [];
    const confirm = vi.fn(async () => true);
    const code = await runConnect({
      link: link(origin),
      home,
      fetch,
      exec,
      platform: 'darwin',
      isTTY: false,
      confirm,
      service,
      sleep: fastSleep,
      machine: { name: 'Mac', os: 'darwin' },
      out: (l) => {
        lines.push(l);
        const m = /confirm the code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(l);
        if (m) setTimeout(() => void hub.approveDevice(m[1]!, { id: 'alice' }), 50);
      },
    });
    expect(code).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('open', [expect.stringMatching(/\/device\?code=/)]);
    expect(restart).toHaveBeenCalledTimes(1);
    const cfg = await loadAgentConfig(home);
    expect(cfg.sites).toEqual([expect.objectContaining({ url: `${origin}/api/uncage` })]);
    expect(lines.join('\n')).toContain('✓ Connected');
    expect(lines.join('\n')).not.toContain(cfg.sites[0]!.token);
    expect(lines.join('\n')).not.toMatch(/scan this/i); // no QR without a terminal
  });

  it('without an installed service: hints to start the agent', async () => {
    const { hub, origin } = await startHub();
    const { service, restart } = fakeService(false);
    const lines: string[] = [];
    const code = await runConnect({
      link: origin,
      home: await tmpHome(),
      fetch,
      exec: vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' })),
      noBrowser: true,
      confirm: async () => true,
      service,
      sleep: fastSleep,
      out: (l) => {
        lines.push(l);
        const m = /confirm the code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(l);
        if (m) setTimeout(() => void hub.approveDevice(m[1]!, { id: 'alice' }), 50);
      },
    });
    expect(code).toBe(0);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toContain('uncage agent');
  });
});
