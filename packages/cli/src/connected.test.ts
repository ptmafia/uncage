import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLog, agentConfigPath, checkUserOnly, loadAgentConfig, updateAgentSites, type ExecFn } from '@uncage/agent';
import { createHub, type Hub } from '@uncage/hub';
import { attachWebSocket, pgliteHubStore, toNodeHandler } from '@uncage/hub/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showActivity } from './activity-cmd.js';
import { launchctlInstallCommands, launchdPlist, launchdService, plistPath, type ServiceSpec } from './service/index.js';
import { runSetup } from './setup.js';
import { formatSites, listSites, removeSite } from './sites.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

async function tmpHome(): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), 'uncage-cli-'));
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

/** Approves the first code printed by setup, as `user`. */
function approver(hub: Hub, user = 'alice') {
  const lines: string[] = [];
  return {
    lines,
    out: (l: string) => {
      lines.push(l);
      const m = /confirm the code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(l);
      if (m) setTimeout(() => void hub.approveDevice(m[1]!, { id: user }), 50);
    },
  };
}

const okExec = () => vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' }));

/** What the old setup passed as programArguments / path, as a spec (macOS). */
const macSpec = (home: string, o: Partial<ServiceSpec> = {}): ServiceSpec => ({
  nodePath: '/usr/local/bin/node',
  cliEntry: '/usr/local/lib/node_modules/@uncage/cli/dist/bin.js',
  args: ['agent'],
  env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home },
  workingDir: home,
  logsDir: `${home}/.uncage/logs`,
  ...o,
});
const fastSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50)));

describe('uncage setup', () => {
  it('runs the device flow against a real hub, opens the browser, saves the site (0600) without a daemon', async () => {
    const { hub, origin } = await startHub();
    const home = await tmpHome();
    const exec = okExec();
    const a = approver(hub);
    const site = await runSetup({ url: origin, home, fetch, exec, out: a.out, noDaemon: true, platform: 'darwin', sleep: fastSleep, machine: { name: 'Mac', os: 'darwin' } });

    expect(site.url).toBe(`${origin}/api/uncage`); // /api/uncage appended
    expect(exec).toHaveBeenCalledWith('open', [expect.stringContaining('/device?code=')]);
    expect(a.lines.join('\n')).toMatch(/confirm the code:\s+[A-Z0-9]{4}-[A-Z0-9]{4}/);
    expect(a.lines.join('\n')).toContain('--no-daemon');
    expect(a.lines.join('\n')).toContain('Transport: WebSocket (falls back to HTTP streaming');
    expect(exec).toHaveBeenCalledTimes(1); // no launchctl
    const cfg = await loadAgentConfig(home);
    expect(cfg.sites).toEqual([expect.objectContaining({ id: site.id, machineId: site.machineId, token: site.token, machineKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) })]);
    if (process.platform === 'win32') expect((await checkUserOnly(agentConfigPath(home))).ok).toBe(true);
    else expect(((await stat(agentConfigPath(home))).mode & 0o777).toString(8)).toBe('600');
    expect(a.lines.join('\n')).not.toContain(site.token);
  });

  it('re-running setup reuses the machineKey, so the website keeps the same machine', async () => {
    const { hub, origin, machines } = await startHub();
    const home = await tmpHome();
    const first = await runSetup({ url: origin, home, fetch, exec: okExec(), out: approver(hub).out, noDaemon: true, noBrowser: true, sleep: fastSleep });
    const second = await runSetup({ url: origin, home, fetch, exec: okExec(), out: approver(hub).out, noDaemon: true, noBrowser: true, sleep: fastSleep });
    expect(second.machineId).toBe(first.machineId);
    expect(second.machineKey).toBe(first.machineKey);
    expect(second.token).not.toBe(first.token);
    expect((await loadAgentConfig(home)).sites).toHaveLength(1);
    expect(await machines('alice')).toHaveLength(1);
  });

  it('on macOS installs the launchd plist and bootstraps it (injected exec, no real launchctl)', async () => {
    const { hub, origin } = await startHub();
    const home = await tmpHome();
    const exec = okExec();
    await runSetup({
      url: origin,
      home,
      fetch,
      exec,
      out: approver(hub).out,
      noBrowser: true,
      platform: 'darwin',
      uid: 501,
      spec: macSpec(home),
      sleep: fastSleep,
    });
    expect(exec.mock.calls).toEqual([
      ['launchctl', ['bootout', 'gui/501/dev.uncage.agent']],
      ['launchctl', ['bootstrap', 'gui/501', plistPath(home)]],
    ]);
    const plist = await readFile(plistPath(home), 'utf8');
    expect(plist).toContain('<string>/usr/local/lib/node_modules/@uncage/cli/dist/bin.js</string>');
    expect(plist).toContain('<string>agent</string>');
  });

  it('setup opens the browser with open / xdg-open / rundll32', async () => {
    const { hub, origin } = await startHub();
    for (const [platform, file, args] of [
      ['darwin', 'open', [expect.stringContaining('/device?code=')]],
      ['linux', 'xdg-open', [expect.stringContaining('/device?code=')]],
      ['win32', 'rundll32', ['url.dll,FileProtocolHandler', expect.stringContaining('/device?code=')]],
    ] as const) {
      const exec = okExec();
      await runSetup({ url: origin, home: await tmpHome(), fetch, exec, out: approver(hub).out, noDaemon: true, platform, sleep: fastSleep });
      expect(exec.mock.calls).toEqual([[file, args]]);
    }
  });

  it('detectServiceKind: linux without a user systemd → none; setup then prints the foreground hint and exits 0', async () => {
    const { hub, origin } = await startHub();
    const home = await tmpHome();
    const exec = vi.fn<ExecFn>(async (file, args) => {
      if (file === 'systemctl') throw Object.assign(new Error('Failed to connect to bus: No medium found'), { code: 1, args });
      return { stdout: '', stderr: '' };
    });
    const a = approver(hub);
    const site = await runSetup({ url: origin, home, fetch, exec, out: a.out, noBrowser: true, platform: 'linux', env: {}, sleep: fastSleep });
    expect(site.machineId).toBeTruthy();
    expect(exec.mock.calls).toEqual([['systemctl', ['--user', 'show-environment']]]);
    expect(a.lines.join('\n')).toContain('Run it in the foreground (e.g. in tmux or screen): uncage agent');
    expect((await loadAgentConfig(home)).sites).toHaveLength(1);
  });

  it('on Linux with a user systemd installs and enables the unit (injected exec)', async () => {
    const { hub, origin } = await startHub();
    const home = await tmpHome();
    const exec = okExec();
    const a = approver(hub);
    await runSetup({ url: origin, home, fetch, exec, out: a.out, noBrowser: true, platform: 'linux', env: { USER: 'u' }, spec: macSpec(home), sleep: fastSleep });
    expect(exec.mock.calls.slice(0, 3)).toEqual([
      ['systemctl', ['--user', 'show-environment']],
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'uncage-agent.service']],
    ]);
    expect(a.lines.join('\n')).toMatch(/Background agent running \(systemd --user: .*uncage-agent\.service\)/);
  });

  it('a denied request ends with a clear error and saves nothing', async () => {
    const { hub, origin } = await startHub();
    const home = await tmpHome();
    const out = (l: string) => {
      const m = /confirm the code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(l);
      if (m) setTimeout(() => void hub.denyDevice(m[1]!, { id: 'alice' }), 50);
    };
    await expect(runSetup({ url: origin, home, fetch, exec: okExec(), out, noDaemon: true, noBrowser: true, sleep: fastSleep })).rejects.toThrow(/denied/);
    expect((await loadAgentConfig(home)).sites).toEqual([]);
  });

  it('refuses plain http to a non-local website', async () => {
    await expect(runSetup({ url: 'http://example.com', home: await tmpHome(), fetch, exec: okExec(), out: () => undefined })).rejects.toThrow(/https/);
  });
});

describe('launchd', () => {
  it('generates a plist with RunAtLoad, KeepAlive on failure, logs in ~/.uncage/logs, escaped values', () => {
    const plist = launchdPlist({
      nodePath: '/usr/bin/node',
      cliEntry: '/x/<bin>.js',
      args: ['agent'],
      env: { PATH: '/usr/bin:/bin', HOME: '/Users/a&b' },
      workingDir: '/Users/a&b',
      logsDir: '/Users/a&b/.uncage/logs',
    });
    expect(plist).toContain('<key>Label</key>\n  <string>dev.uncage.agent</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain('<string>/Users/a&amp;b/.uncage/logs/agent.log</string>');
    expect(plist).toContain('<string>/Users/a&amp;b/.uncage/logs/agent.err.log</string>');
    expect(plist).toContain('<string>/x/&lt;bin&gt;.js</string>');
    expect(plist).toContain('<key>PATH</key>\n    <string>/usr/bin:/bin</string>');
    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/Users/a&amp;b</string>');
  });

  it('builds bootout + bootstrap for gui/<uid>', () => {
    expect(launchctlInstallCommands(502, '/p.plist')).toEqual([
      ['launchctl', ['bootout', 'gui/502/dev.uncage.agent']],
      ['launchctl', ['bootstrap', 'gui/502', '/p.plist']],
    ]);
  });

  it('install tolerates a failing bootout, reports a failing bootstrap; uninstall boots out and removes the plist', async () => {
    const home = await tmpHome();
    const exec = vi.fn<ExecFn>(async (_f, args) => {
      if (args[0] === 'bootout') throw Object.assign(new Error('not loaded'), { stderr: 'Boot-out failed: 3: No such process' });
      return { stdout: '', stderr: '' };
    });
    const svc = (e: ExecFn) => launchdService({ platform: 'darwin', home, env: {}, exec: e, uid: 501 });
    expect(await svc(exec).install(macSpec(home))).toEqual({ definitionPath: plistPath(home), notes: [] });
    expect(exec.mock.calls).toEqual([
      ['launchctl', ['bootout', 'gui/501/dev.uncage.agent']],
      ['launchctl', ['bootstrap', 'gui/501', plistPath(home)]],
    ]);
    expect((await stat(plistPath(home))).isFile()).toBe(true);
    expect((await stat(join(home, '.uncage', 'logs'))).isDirectory()).toBe(true);

    const failing = vi.fn<ExecFn>(async (_f, args) => {
      if (args[0] === 'bootstrap') throw Object.assign(new Error('x'), { stderr: 'Bootstrap failed: 5: Input/output error' });
      return { stdout: '', stderr: '' };
    });
    await expect(svc(failing).install(macSpec(home))).rejects.toThrow(/Bootstrap failed: 5/);

    const ex2 = okExec();
    expect(await svc(ex2).restart()).toBe(true);
    expect(ex2).toHaveBeenCalledWith('launchctl', ['kickstart', '-k', 'gui/501/dev.uncage.agent']);
    expect(await svc(ex2).uninstall()).toEqual({ removed: true });
    expect(ex2).toHaveBeenCalledWith('launchctl', ['bootout', 'gui/501/dev.uncage.agent']);
    await expect(stat(plistPath(home))).rejects.toThrow();
    expect(await svc(ex2).uninstall()).toEqual({ removed: false });
  });
});

describe('uncage sites', () => {
  it('lists sites and removes one, revoking the machine on the website', async () => {
    const { hub, origin, machines } = await startHub();
    const home = await tmpHome();
    const site = await runSetup({ url: origin, home, fetch, exec: okExec(), out: approver(hub).out, noDaemon: true, noBrowser: true, sleep: fastSleep });
    const listed = await listSites(home);
    expect(listed).toContain(site.id);
    expect(listed).toContain('active');
    expect(listed).not.toContain(site.token);
    expect(await machines('alice')).toHaveLength(1);

    const lines: string[] = [];
    await removeSite({ home, id: site.id, fetch, out: (l) => lines.push(l) });
    expect(lines.join('\n')).toMatch(/Revoked this machine/);
    expect(await machines('alice')).toEqual([]);
    expect((await loadAgentConfig(home)).sites).toEqual([]);
    await expect(removeSite({ home, id: site.id, fetch, out: () => undefined })).rejects.toThrow(/No connected website/);
  });

  it('removes locally even when the website is unreachable', async () => {
    const home = await tmpHome();
    await updateAgentSites(home, () => [{ id: 'gone.example', name: 'Gone', url: 'http://127.0.0.1:1/api/uncage', machineId: 'm', token: 't' }]);
    const lines: string[] = [];
    await removeSite({ home, id: 'gone.example', fetch, out: (l) => lines.push(l) });
    expect(lines.join('\n')).toMatch(/Could not reach/);
    expect((await loadAgentConfig(home)).sites).toEqual([]);
  });

  it('formats an empty list helpfully and marks revoked sites', () => {
    expect(formatSites([])).toMatch(/uncage setup/);
    expect(formatSites([{ id: 'a', name: 'A', url: 'https://a.example/api/uncage', machineId: 'm', token: 't', revokedAt: '2026-11-07T00:00:00Z' }])).toContain('revoked');
  });
});

describe('uncage activity', () => {
  it('prints entries across sites in time order and follows new ones', async () => {
    const home = await tmpHome();
    await updateAgentSites(home, () => [
      { id: 'a.example', name: 'A', url: 'https://a.example/api/uncage', machineId: 'm', token: 't' },
      { id: 'b.example', name: 'B', url: 'https://b.example/api/uncage', machineId: 'm', token: 't' },
    ]);
    const la = new ActivityLog(home, 'a.example');
    const lb = new ActivityLog(home, 'b.example');
    await la.append({ kind: 'command', name: 'createSession', ok: true });
    await new Promise((r) => setTimeout(r, 5));
    await lb.append({ kind: 'command', name: 'startRun', ok: false, code: 'policy_denied', detail: { prompt: 'secret' } });

    const out: string[] = [];
    await showActivity({ home, out: (l) => out.push(l) });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('a.example  command createSession ok');
    expect(out[1]).toContain('b.example  command startRun failed (policy_denied)');
    expect(out[1]).not.toContain('secret');

    const only: string[] = [];
    await showActivity({ home, site: 'b.example', json: true, out: (l) => only.push(l) });
    expect(JSON.parse(only[0]!)).toMatchObject({ site: 'b.example', name: 'startRun' });
    await expect(showActivity({ home, site: 'nope', out: () => undefined })).rejects.toThrow(/No connected website/);

    const ac = new AbortController();
    const followed: string[] = [];
    const following = showActivity({ home, follow: true, out: (l) => followed.push(l), signal: ac.signal, pollMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    await la.append({ kind: 'tool_call', name: 'publish_asset', ok: true });
    for (let i = 0; i < 100 && !followed.some((l) => l.includes('publish_asset')); i++) await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await following;
    expect(followed.at(-1)).toContain('tool_call publish_asset ok');
  });
});
