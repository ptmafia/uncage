import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLog, loadAgentConfig, updateAgentSites, type ExecFn } from '@uncage/agent';
import { createHub, type Hub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentService, ServiceStatus } from '../service/index.js';
import { runSetup } from '../setup.js';
import { startDashboard } from './server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

async function tmpHome(): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), 'uncage-dash-'));
  cleanups.push(() => rm(h, { recursive: true, force: true }));
  return h;
}

async function startHub(): Promise<{ hub: Hub; origin: string; machines(user: string): Promise<Array<{ id: string }>> }> {
  const store = await pgliteHubStore({ dataDir: 'memory://' });
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const hub = await createHub({ publicUrl: origin, store, getUser: async (req) => (req.headers.get('x-user') ? { id: req.headers.get('x-user')! } : null) });
  const node = toNodeHandler(hub);
  server.on('request', (req, res) => node(req, res));
  attachWebSocket(hub, server);
  cleanups.push(async () => {
    await hub.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
  });
  return {
    hub,
    origin,
    machines: async (user) => (await (await fetch(`${origin}/api/uncage/machines`, { headers: { 'x-user': user } })).json()) as Array<{ id: string }>,
  };
}

const okExec = () => vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' }));
const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50)));

/** Pairs `home` with the test hub through the real device flow (approved as alice). */
async function pair(hub: Hub, origin: string, home: string) {
  return runSetup({
    url: origin,
    home,
    fetch,
    exec: okExec(),
    noDaemon: true,
    noBrowser: true,
    sleep: fastSleep,
    machine: { name: 'Test Mac', os: 'darwin' },
    out: (l) => {
      const m = /confirm the code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(l);
      if (m) setTimeout(() => void hub.approveDevice(m[1]!, { id: 'alice' }), 50);
    },
  });
}

function fakeService(running: boolean | null = true): AgentService & { restarts: number } {
  const svc = {
    kind: 'launchd' as const,
    restarts: 0,
    install: async () => ({ definitionPath: '/x', notes: [] }),
    uninstall: async () => ({ removed: true }),
    restart: async () => {
      svc.restarts++;
      return true;
    },
    status: async (): Promise<ServiceStatus> => ({ kind: 'launchd', installed: true, running, spec: null, nodeExists: true, nodeVersion: 'v22', definitionPath: '/x' }),
  };
  return svc;
}

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw HTTP request (fetch cannot forge Host). */
function raw(url: string, o: { method?: string; headers?: Record<string, string>; path?: string } = {}): Promise<Raw> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: u.port, path: o.path ?? `${u.pathname}${u.search}`, method: o.method ?? 'GET', headers: o.headers ?? {} }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function dashboard(home: string, extra: Partial<Parameters<typeof startDashboard>[0]> = {}) {
  const exec = okExec();
  const d = await startDashboard({ home, exec, open: false, service: fakeService(), fetch, ...extra });
  cleanups.push(() => d.close());
  const u = new URL(d.url);
  const token = u.searchParams.get('t')!;
  const self = `${u.protocol}//${u.host}`;
  /** The first visit: the session cookie it sets, and the per-session API header token from the page. */
  const login = async (): Promise<{ cookie: string; api: string; h: Record<string, string> }> => {
    const r = await raw(d.url, { headers: { host: u.host } });
    expect(r.status).toBe(303);
    const cookie = String(r.headers['set-cookie']).split(';')[0]!;
    const page = await raw(`${self}/`, { headers: { host: u.host, cookie } });
    const api = /"apiToken":"([A-Za-z0-9_-]+)"/.exec(page.body)?.[1] ?? '';
    expect(api).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return { cookie, api, h: { host: u.host, cookie, 'x-uncage-dashboard': api } };
  };
  return { d, u, token, self, host: u.host, login, exec };
}

describe('uncage dashboard', () => {
  it('403 without token, with wrong Host (rebinding), from another origin', async () => {
    const home = await tmpHome();
    const { d, u, token, self, host } = await dashboard(home);
    expect(u.hostname).toBe('127.0.0.1');
    expect(u.port).not.toBe('');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url

    // No token at all.
    expect((await raw(`${self}/`, { headers: { host } })).status).toBe(403);
    expect((await raw(`${self}/api/sites`, { headers: { host } })).status).toBe(403);
    // Wrong token.
    expect((await raw(`${self}/?t=${'A'.repeat(43)}`, { headers: { host } })).status).toBe(403);
    // DNS rebinding: the right token, but a page on evil.com resolving to 127.0.0.1.
    expect((await raw(d.url, { headers: { host: `evil.com:${u.port}` } })).status).toBe(403);
    expect((await raw(d.url, { headers: { host: 'evil.com' } })).status).toBe(403);
    expect((await raw(d.url, { headers: { host: `localhost:${u.port}` } })).status).toBe(403);

    // The first visit trades the token for an HttpOnly SameSite=Strict session cookie (a separate
    // secret) and drops it from the URL.
    const first = await raw(d.url, { headers: { host } });
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe('/');
    const setCookie = String(first.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).not.toContain(token);
    expect(first.headers['referrer-policy']).toBe('no-referrer');
    const cookie = setCookie.split(';')[0]!;
    // One-time: the link (in shell history, the browser's argv) no longer opens anything.
    expect((await raw(d.url, { headers: { host } })).status).toBe(403);
    // The token itself is never a session.
    expect((await raw(`${self}/`, { headers: { host, cookie: `${cookie.split('=')[0]}=${token}` } })).status).toBe(403);

    // With the cookie: the page works, with no CORS headers and a strict CSP.
    const page = await raw(`${self}/`, { headers: { host, cookie } });
    expect(page.status).toBe(200);
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(page.body).toContain(`<script nonce="${nonce}">`);
    expect(page.body).not.toContain(token);
    const api = /"apiToken":"([A-Za-z0-9_-]+)"/.exec(page.body)?.[1] ?? '';
    expect(api).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie).not.toContain(api);
    const h = { host, cookie, 'x-uncage-dashboard': api };

    // The API also needs the per-session header token (a cookie harvested by another
    // 127.0.0.1 server, cookies ignore ports, is not enough).
    expect((await raw(`${self}/api/sites`, { headers: { host, cookie } })).status).toBe(403);
    expect((await raw(`${self}/api/sites`, { headers: { ...h, 'x-uncage-dashboard': 'C'.repeat(43) } })).status).toBe(403);
    expect((await raw(`${self}/api/sites`, { headers: { host, 'x-uncage-dashboard': api } })).status).toBe(403);
    const ok = await raw(`${self}/api/sites`, { headers: h });
    expect(ok.status).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBeUndefined();

    // Neither helps a rebinding page or another origin.
    expect((await raw(`${self}/api/sites`, { headers: { ...h, host: `evil.com:${u.port}` } })).status).toBe(403);
    expect((await raw(`${self}/api/sites`, { headers: { ...h, origin: 'http://evil.com' } })).status).toBe(403);
    expect((await raw(`${self}/api/sites`, { headers: { ...h, origin: `http://localhost:${u.port}` } })).status).toBe(403);
    // A preflight gets nothing.
    const pre = await raw(`${self}/api/sites`, { method: 'OPTIONS', headers: { host, origin: 'http://evil.com', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(403);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();

    // POSTs need the cookie, the header token AND the dashboard's own Origin.
    const post = (headers: Record<string, string>) => raw(`${self}/api/runtimes/gemini/disable`, { method: 'POST', headers });
    expect((await post({ host, 'x-uncage-dashboard': api, origin: self })).status).toBe(403); // no cookie
    expect((await post({ host, cookie, origin: self })).status).toBe(403); // no header token
    expect((await post(h)).status).toBe(403); // no Origin
    expect((await post({ ...h, origin: 'http://evil.com' })).status).toBe(403);
    expect((await post({ ...h, cookie: `${cookie.split('=')[0]}=${'B'.repeat(43)}`, origin: self })).status).toBe(403);
    expect((await post({ ...h, origin: 'null' })).status).toBe(403);
    expect((await raw(`${self}/api/runtimes/gemini/disable?t=${token}`, { method: 'POST', headers: { host, origin: self } })).status).toBe(403);
    expect((await loadAgentConfig(home)).runtimes?.acp.disable).toEqual([]);
    expect((await post({ ...h, origin: self })).status).toBe(200);
    // A malformed escape in the path is a bad request, not a server error.
    expect((await raw(`${self}/api/sites/%E0%A4%A/disconnect`, { method: 'POST', headers: { ...h, origin: self } })).status).toBe(400);
    expect((await raw(`${self}/api/runtimes/%ZZ/enable`, { method: 'POST', headers: { ...h, origin: self } })).status).toBe(400);
  });

  it('lists sites with domain and status', async () => {
    const { hub, origin } = await startHub();
    const home = await tmpHome();
    const site = await pair(hub, origin, home);
    await updateAgentSites(home, (s) => [...s, { id: 'shop.example', name: 'Shop', url: 'https://app.shop.co.uk/api/uncage', machineId: 'm-2', token: 'tok-2' }]);
    const log = new ActivityLog(home, site.id);
    await log.append({ kind: 'connected', name: 'ws' });
    for (let i = 0; i < 25; i++) await log.append({ kind: 'command', name: 'session.start', ok: true, detail: { prompt: 'secret prompt text' } });
    await log.flush();

    const { self, login } = await dashboard(home);
    const { h } = await login();
    const r = await raw(`${self}/api/sites`, { headers: h });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as {
      agent: { kind: string; running: boolean | null };
      policy: { allowBypass: boolean };
      runtimes: Array<{ id: string; state: string }>;
      sites: Array<{ id: string; name: string; domain: string; origin: string; machineId: string; connectedAt?: string; state: string; transport?: string; runtimes: string[]; activity: Array<{ kind: string; detail?: unknown }> }>;
    };
    expect(body.agent).toMatchObject({ kind: 'launchd', running: true });
    expect(body.policy).toMatchObject({ allowBypass: false });
    expect(body.runtimes.map((x) => x.id)).toEqual(expect.arrayContaining(['claude', 'codex']));
    const [paired, shop] = body.sites;
    expect(paired).toMatchObject({ id: site.id, name: site.name, domain: '127.0.0.1', origin, machineId: site.machineId, state: 'online', transport: 'ws' });
    expect(paired!.connectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(paired!.runtimes).toEqual(expect.arrayContaining(['claude', 'codex']));
    expect(paired!.activity).toHaveLength(20);
    expect(paired!.activity[0]!.kind).toBe('command'); // newest first
    expect(JSON.stringify(paired!.activity)).not.toContain('secret prompt text');
    expect(shop).toMatchObject({ id: 'shop.example', domain: 'shop.co.uk', origin: 'https://app.shop.co.uk', state: 'offline', activity: [] });
    // The machine token never leaves the computer.
    expect(r.body).not.toContain(site.token);
    expect(r.body).not.toContain('tok-2');
  });

  it('a stopped agent shows its sites offline; a revoked site shows revoked', async () => {
    const home = await tmpHome();
    await updateAgentSites(home, () => [
      { id: 'a.example', name: 'A', url: 'https://a.example/api/uncage', machineId: 'm', token: 't' },
      { id: 'b.example', name: 'B', url: 'https://b.example/api/uncage', machineId: 'm', token: 't2', revokedAt: '2026-11-08T00:00:00Z' },
    ]);
    const log = new ActivityLog(home, 'a.example');
    await log.append({ kind: 'connected', name: 'http' });
    const { self, login } = await dashboard(home, { service: fakeService(false) });
    const { h } = await login();
    const body = JSON.parse((await raw(`${self}/api/sites`, { headers: h })).body) as { sites: Array<{ state: string }> };
    expect(body.sites.map((s) => s.state)).toEqual(['offline', 'revoked']);
  });

  it('disconnect revokes on the hub and removes the site', async () => {
    const { hub, origin, machines } = await startHub();
    const home = await tmpHome();
    const site = await pair(hub, origin, home);
    expect(await machines('alice')).toHaveLength(1);
    const service = fakeService();
    const { self, login } = await dashboard(home, { service });
    const { h } = await login();

    const missing = await raw(`${self}/api/sites/nope.example/disconnect`, { method: 'POST', headers: { ...h, origin: self } });
    expect(missing.status).toBe(404);

    const r = await raw(`${self}/api/sites/${encodeURIComponent(site.id)}/disconnect`, { method: 'POST', headers: { ...h, origin: self } });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ code: 'disconnected', name: site.name, domain: '127.0.0.1', revoke: 'revoked', restart: 'restarted' });
    expect((JSON.parse(r.body) as { messages: string[] }).messages.join('\n')).toMatch(/Revoked this machine/);
    expect(JSON.parse(missing.body)).toMatchObject({ error: { code: 'not_found' } });
    expect(await machines('alice')).toEqual([]);
    expect((await loadAgentConfig(home)).sites).toEqual([]);
    expect(service.restarts).toBe(1);
  });

  it('a proxy 401 keeps the site and reports the error (same rule as uncage sites remove)', async () => {
    const home = await tmpHome();
    await updateAgentSites(home, () => [{ id: 'p.example', name: 'P', url: 'https://p.example/api/uncage', machineId: 'm', token: 't' }]);
    const proxy = (async () => new Response('<html>gate</html>', { status: 401 })) as typeof fetch;
    const service = fakeService();
    const { self, login } = await dashboard(home, { service, fetch: proxy });
    const { h } = await login();
    const r = await raw(`${self}/api/sites/p.example/disconnect`, { method: 'POST', headers: { ...h, origin: self } });
    expect(r.status).toBe(502);
    expect(r.body).toMatch(/not from Uncage/);
    expect(JSON.parse(r.body)).toMatchObject({ error: { code: 'not_revoked' } });
    expect((await loadAgentConfig(home)).sites).toHaveLength(1);
    expect(service.restarts).toBe(0);
  });

  it('runtime toggle respects consent rules', async () => {
    const home = await tmpHome();
    const service = fakeService();
    const { self, login } = await dashboard(home, { service, which: async () => null });
    const { h } = await login();
    const post = (path: string) => raw(`${self}${path}`, { method: 'POST', headers: { ...h, origin: self } });

    // Enabling an npx agent records a consent bound to that package (what will run is reported).
    const en = await post('/api/runtimes/gemini/enable');
    expect(en.status).toBe(200);
    expect((JSON.parse(en.body) as { messages: string[] }).messages.join('\n')).toMatch(/download and run @google\/gemini-cli from npm/);
    expect(JSON.parse(en.body)).toMatchObject({ code: 'runtime_enabled', name: 'Gemini CLI', download: 'npm', runs: expect.stringContaining('@google/gemini-cli'), restart: 'restarted' });
    expect((await loadAgentConfig(home)).runtimes?.acp).toMatchObject({
      enable: ['gemini'],
      consented: { gemini: { runner: 'npx', package: '@google/gemini-cli', args: ['--acp'] } },
      disable: [],
    });
    let list = JSON.parse((await raw(`${self}/api/sites`, { headers: h })).body) as { runtimes: Array<{ id: string; state: string }> };
    expect(list.runtimes.find((x) => x.id === 'gemini')?.state).toBe('enabled');

    // Unknown agents are refused and nothing is written.
    const bad = await post('/api/runtimes/no-such-agent/enable');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatch(/Unknown ACP agent/);
    expect(JSON.parse(bad.body)).toMatchObject({ error: { code: 'unknown_agent' } });
    // Built-in runtimes are not ACP agents: not toggled here.
    const builtin = await post('/api/runtimes/claude/disable');
    expect(builtin.status).toBe(400);
    expect(JSON.parse(builtin.body)).toMatchObject({ error: { code: 'builtin' } });
    expect((await post('/api/runtimes/gemini/explode')).status).toBe(404);

    // Disabling drops the consent and blocks it.
    const dis = await post('/api/runtimes/acp-gemini/disable');
    expect(dis.status).toBe(200);
    expect(JSON.parse(dis.body)).toMatchObject({ code: 'runtime_disabled' });
    expect((await loadAgentConfig(home)).runtimes?.acp).toMatchObject({ enable: [], consented: {}, disable: ['gemini'] });
    list = JSON.parse((await raw(`${self}/api/sites`, { headers: h })).body) as { runtimes: Array<{ id: string; state: string }> };
    expect(list.runtimes.find((x) => x.id === 'gemini')?.state).toBe('disabled');
    expect(service.restarts).toBe(2);
  });

  it('opens the browser with the tokenized URL through the injected exec', async () => {
    const home = await tmpHome();
    const exec = okExec();
    const d = await startDashboard({ home, exec, platform: 'darwin', service: null });
    cleanups.push(() => d.close());
    expect(exec).toHaveBeenCalledWith('open', [d.url]);
    expect(d.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]{43}$/);
  });

  it('exits after the idle timeout and when the page says goodbye', async () => {
    const home = await tmpHome();
    const d = await startDashboard({ home, exec: okExec(), open: false, service: null, idleMs: 100 });
    cleanups.push(() => d.close());
    await expect(Promise.race([d.closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('timeout'), 2000))])).resolves.toBe('closed');

    const { self, login, d: d2 } = await dashboard(home, { service: null, graceMs: 50 });
    const { h } = await login();
    expect((await raw(`${self}/api/bye`, { method: 'POST', headers: { ...h, origin: self } })).status).toBe(204);
    await expect(Promise.race([d2.closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('timeout'), 2000))])).resolves.toBe('closed');
  });

  it('serves the page in the system language', async () => {
    const home = await tmpHome();
    for (const [locale, lang, text] of [
      ['zh', 'zh-CN', '已连接的网站'],
      ['zh', 'zh-CN', '已在网站上撤销这台电脑'],
      ['zh', 'zh-CN', '"failed":"失败"'],
      ['ja', 'ja', '接続済みのサイト'],
      ['ja', 'ja', 'サイト上でこのコンピューターを取り消しました'],
      ['ja', 'ja', '"failed":"失敗"'],
      ['en', 'en', 'Connected websites'],
    ] as const) {
      const { self, login } = await dashboard(home, { service: null, locale });
      const { h } = await login();
      const page = await raw(`${self}/`, { headers: h });
      expect(page.body).toContain(`<html lang="${lang}">`);
      expect(page.body).toContain(text);
    }
  });
});
