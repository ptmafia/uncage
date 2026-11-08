import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAcpPath } from '@uncage/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAcpAgents, discoverAcpAgents, hostPlatform } from './discover.js';
import { bundledRegistry, parseRegistry, type AcpRegistry } from './registry.js';
import { FAKE_ICON_SVG, fakeRegistry } from './test-registry.js';
import { cmdLine, createWhich, relativeWindowsExecutable, spawnableCommand, systemCmd } from './which.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const ICON = `data:image/svg+xml;base64,${Buffer.from(FAKE_ICON_SVG).toString('base64')}`;
/** The fake registry as a snapshot: icons already downloaded as data URIs. */
const registry = (): AcpRegistry => {
  const { version, agents } = parseRegistry(fakeRegistry);
  return { version, agents: agents.map((a) => ({ ...a, icon: ICON })), fetchedAt: '2026-11-08T00:00:00.000Z', source: 'bundled' };
};

/** A temp PATH with fake executables; `npx`/`uvx` record every invocation. */
async function fakePath(bins: Record<string, 'acp' | 'broken'>) {
  const root = await mkdtemp(join(tmpdir(), 'uncage-acp-disc-'));
  dirs.push(root);
  const bin = join(root, 'bin');
  const cache = join(root, 'cache');
  const log = join(root, 'invocations.log');
  await mkdir(bin);
  const script = (body: string) => `#!/bin/sh\n${body}\n`;
  for (const [name, kind] of Object.entries(bins)) {
    const body = kind === 'acp' ? `exec "${process.execPath}" "${fakeAcpPath}" "$@"` : 'echo broken >&2; exit 3';
    await writeFile(join(bin, name), script(body));
    await chmod(join(bin, name), 0o755);
  }
  for (const runner of ['npx', 'uvx']) {
    await writeFile(join(bin, runner), script(`echo "${runner} $*" >> "${log}"; exit 1`));
    await chmod(join(bin, runner), 0o755);
  }
  const invocations = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { bin, cache, which: createWhich({ PATH: bin }), invocations };
}

const base = { presets: 'off' as const, agents: [] };

describe('ACP registry discovery', () => {
  it('a binary agent on PATH that passes the ACP handshake is enabled, with its icon; the process is gone afterwards', async () => {
    const p = await fakePath({ fakebin: 'acp' });
    const r = await discoverAcpAgents({ registry: registry(), config: base, allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache });
    expect(r.adapters.map((a) => [a.id, a.displayName, a.command])).toEqual([['acp-fakebin', 'Fake Bin', [join(p.bin, 'fakebin'), 'acp']]]);
    expect(r.catalog.find((c) => c.registryId === 'fakebin')).toMatchObject({ status: 'enabled', runtimeId: 'acp-fakebin', agentVersion: '1.0.0' });
    // The npx entry is listed as available (needs consent) and never run.
    expect(r.catalog.find((c) => c.registryId === 'fakenpx')).toMatchObject({ status: 'available', distribution: 'npx' });
    expect(await p.invocations()).toEqual([]);
  });

  it('the handshake result is cached per path and file version', async () => {
    const p = await fakePath({ fakebin: 'acp' });
    const o = { registry: registry(), config: base, allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache };
    const probes: string[] = [];
    const handshake = async (a: { command: string[] }) => {
      probes.push(a.command[0]!);
      return { status: 'available' as const, version: '9.9.9' };
    };
    await discoverAcpAgents({ ...o, handshake });
    await discoverAcpAgents({ ...o, handshake });
    expect(probes).toHaveLength(1);
    // A new binary at the same path (different size/mtime) is checked again.
    await writeFile(join(p.bin, 'fakebin'), `#!/bin/sh\nexec "${process.execPath}" "${fakeAcpPath}" "$@" # v2\n`);
    const r = await discoverAcpAgents({ ...o, handshake });
    expect(probes).toHaveLength(2);
    expect(r.catalog.find((c) => c.registryId === 'fakebin')?.agentVersion).toBe('9.9.9');
    expect((await stat(join(p.cache, 'detect.json'))).isFile()).toBe(true);
  });

  it('a binary that fails the handshake is not enabled', async () => {
    const p = await fakePath({ fakebin: 'broken' });
    const r = await discoverAcpAgents({ registry: registry(), config: base, allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache });
    expect(r.adapters).toEqual([]);
    expect(r.catalog.find((c) => c.registryId === 'fakebin')).toMatchObject({ status: 'failed' });
  });

  it('not on PATH → not installed; autoDetect false → nothing is probed', async () => {
    const p = await fakePath({});
    const r = await discoverAcpAgents({ registry: registry(), config: base, allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache });
    expect(r.adapters).toEqual([]);
    expect(r.catalog.find((c) => c.registryId === 'fakebin')?.status).toBe('not_installed');
    const q = await fakePath({ fakebin: 'acp' });
    let probed = 0;
    const r2 = await discoverAcpAgents({
      registry: registry(), config: { ...base, autoDetect: false }, allowBypass: false, which: q.which, platform: hostPlatform(), cacheDir: q.cache,
      handshake: async () => {
        probed++;
        return { status: 'available' };
      },
    });
    expect(probed).toBe(0);
    expect(r2.adapters).toEqual([]);
  });

  it('disable wins over detection; enable gives consent to an npx entry (registered, still not run here)', async () => {
    const p = await fakePath({ fakebin: 'acp' });
    const o = { registry: registry(), allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache };
    const off = await discoverAcpAgents({ ...o, config: { ...base, disable: ['fakebin'] } });
    expect(off.adapters).toEqual([]);
    expect(off.catalog.find((c) => c.registryId === 'fakebin')?.status).toBe('disabled');
    const on = await discoverAcpAgents({ ...o, config: { ...base, enable: ['fakenpx'], consented: { fakenpx: { runner: 'npx' as const, package: 'fake-npx', args: ['--acp'], env: {} } }, disable: ['acp-fakebin'] } });
    expect(on.adapters.map((a) => [a.id, a.command])).toEqual([['acp-fakenpx', ['npx', '-y', 'fake-npx@0.1.0', '--acp']]]);
    expect(on.catalog.find((c) => c.registryId === 'fakenpx')?.status).toBe('enabled');
    expect(await p.invocations()).toEqual([]);
  });

  it('manual entries win over registry entries with the same id', async () => {
    const p = await fakePath({ fakebin: 'acp' });
    const r = await buildAcpAgents(
      { presets: 'off', agents: [{ id: 'fakebin', displayName: 'Mine', command: ['node', fakeAcpPath], mcp: 'auto', enabled: true }] },
      { registry: registry(), allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache },
    );
    expect(r.adapters.map((a) => [a.id, a.displayName])).toEqual([['acp-fakebin', 'Mine']]);
    // It still gets the registry's official icon.
    expect(r.adapters[0]!.icon?.light).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(r.catalog.find((c) => c.registryId === 'fakebin')?.status).toBe('manual');
  });

  it('consent is bound to the full spec (runner, package, args, env): any change needs enable again', async () => {
    const p = await fakePath({});
    const o = { allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache };
    const cfg = { ...base, enable: ['fakenpx'], consented: { fakenpx: { runner: 'npx' as const, package: 'fake-npx', args: ['--acp'], env: {} } } };
    const withPkg = (dist: unknown): AcpRegistry => {
      const r = registry();
      return { ...r, agents: r.agents.map((a) => (a.id === 'fakenpx' ? { ...a, distribution: dist as typeof a.distribution } : a)) };
    };
    // A new version of the same package with the same args/env is still covered.
    const same = await discoverAcpAgents({ ...o, config: cfg, registry: withPkg({ npx: { package: 'fake-npx@0.2.0', args: ['--acp'], env: {} } }) });
    expect(same.adapters.map((a) => a.command)).toEqual([['npx', '-y', 'fake-npx@0.2.0', '--acp']]);
    const changes: Array<[unknown, RegExp]> = [
      [{ npx: { package: 'evil-npx@1.0.0', args: ['--acp'], env: {} } }, /now runs "npx evil-npx --acp"/],
      [{ uvx: { package: 'fake-npx==1.0', args: ['--acp'], env: {} } }, /now runs "uvx fake-npx --acp"/],
      [{ npx: { package: 'fake-npx@0.1.0', args: ['--acp', '--yolo'], env: {} } }, /now runs "npx fake-npx --acp --yolo"/],
      [{ npx: { package: 'fake-npx@0.1.0', args: ['--acp'], env: { AGENT_HOOK: 'x' } } }, /now runs "npx fake-npx --acp AGENT_HOOK=x"/],
    ];
    for (const [dist, why] of changes) {
      const r = await discoverAcpAgents({ ...o, config: cfg, registry: withPkg(dist) });
      expect(r.adapters).toEqual([]);
      expect(r.catalog.find((c) => c.registryId === 'fakenpx')).toMatchObject({ status: 'available', message: expect.stringMatching(why) });
    }
    // `enable` without a recorded spec (hand-edited) is not consent to download.
    const bare = await discoverAcpAgents({ ...o, config: { ...base, enable: ['fakenpx'] }, registry: registry() });
    expect(bare.adapters).toEqual([]);
    expect(await p.invocations()).toEqual([]);
  });

  it('an enabled binary runs only with the command it was enabled with', async () => {
    const p = await fakePath({ fakebin: 'acp' });
    let probes = 0;
    const handshake = async () => {
      probes++;
      return { status: 'available' as const };
    };
    const bin = (args: string[]): AcpRegistry => {
      const r = registry();
      return {
        ...r,
        source: 'cache',
        agents: r.agents.map((a) =>
          a.id === 'fakebin' ? { ...a, distribution: { binary: Object.fromEntries(Object.entries(a.distribution.binary!).map(([k, v]) => [k, { ...v, args }])) } } : a,
        ),
      };
    };
    const consent = { runner: 'local' as const, cmd: 'fakebin', args: ['--custom'], env: {} };
    const o = { config: { ...base, enable: ['fakebin'], consented: { fakebin: consent } }, allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache, handshake, bundled: registry() };
    const ok = await discoverAcpAgents({ ...o, registry: bin(['--custom']) });
    expect(ok.adapters.map((a) => a.command)).toEqual([[join(p.bin, 'fakebin'), '--custom']]);
    expect(ok.catalog[0]).toMatchObject({ status: 'enabled', via: 'consent' });
    expect(probes).toBe(0);
    const changed = await discoverAcpAgents({ ...o, registry: bin(['--custom', '--evil']) });
    expect(changed.adapters).toEqual([]);
    expect(changed.catalog.find((c) => c.registryId === 'fakebin')).toMatchObject({
      status: 'available',
      message: expect.stringMatching(/changed since you enabled it \(was: fakebin --custom; now: fakebin --custom --evil\)/),
    });
    expect(probes).toBe(0);
    // Back to the bundled command: the normal (handshaken) detection applies again.
    const back = await discoverAcpAgents({ ...o, registry: bin(['acp']) });
    expect(back.catalog.find((c) => c.registryId === 'fakebin')).toMatchObject({ status: 'enabled', via: 'detected' });
  });

  it('after a refresh, a binary is handshaken only if its command equals the bundled or last handshaken one', async () => {
    const p = await fakePath({ fakebin: 'acp' });
    const probes: string[][] = [];
    const handshake = async (a: { command: string[] }) => {
      probes.push(a.command);
      return { status: 'available' as const, version: '1.0.0' };
    };
    const refreshed = (args: string[], env: Record<string, string> = {}): AcpRegistry => {
      const r = registry();
      return {
        ...r,
        source: 'cache',
        agents: r.agents.map((a) =>
          a.id === 'fakebin' ? { ...a, distribution: { binary: Object.fromEntries(Object.entries(a.distribution.binary!).map(([k, v]) => [k, { ...v, args, env }])) } } : a,
        ),
      };
    };
    const o = { config: base, allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache, handshake, bundled: registry() };
    // Same as bundled → handshaken and enabled.
    expect((await discoverAcpAgents({ ...o, registry: refreshed(['acp']) })).adapters.map((a) => a.id)).toEqual(['acp-fakebin']);
    // Changed args or env → available, never started.
    for (const changed of [refreshed(['--eval', 'x']), refreshed(['acp'], { AGENT_MODE: 'evil' })]) {
      const r = await discoverAcpAgents({ ...o, registry: changed });
      expect(r.adapters).toEqual([]);
      expect(r.catalog.find((c) => c.registryId === 'fakebin')).toMatchObject({ status: 'available', message: expect.stringMatching(/changed in the refreshed ACP registry/), hint: 'uncage runtimes enable fakebin' });
    }
    expect(probes).toHaveLength(1);
    // The last handshaken command stays trusted even when the bundled snapshot no longer has it.
    const empty: AcpRegistry = { ...registry(), agents: [] };
    expect((await discoverAcpAgents({ ...o, bundled: empty, registry: refreshed(['acp']) })).adapters.map((a) => a.id)).toEqual(['acp-fakebin']);
    // Enabling exactly that command lets it run.
    const on = await discoverAcpAgents({
      ...o,
      config: { ...base, enable: ['fakebin'], consented: { fakebin: { runner: 'local', cmd: 'fakebin', args: ['--other'], env: {} } } },
      registry: refreshed(['--other']),
    });
    expect(on.adapters.map((a) => a.command)).toEqual([[join(p.bin, 'fakebin'), '--other']]);
  });

  it('registry entries resolving to an already registered command are duplicates', async () => {
    const p = await fakePath({ fakebin: 'acp' });
    const r = registry();
    const twin = { ...r.agents.find((a) => a.id === 'fakebin')!, id: 'fakebin-v2', name: 'Fake Bin V2' };
    const reg = { ...r, agents: [...r.agents, twin] };
    const d = await discoverAcpAgents({
      registry: reg, config: base, allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache,
      handshake: async () => ({ status: 'available' }),
    });
    expect(d.adapters.map((a) => a.id)).toEqual(['acp-fakebin']);
    expect(d.catalog.find((c) => c.registryId === 'fakebin-v2')).toMatchObject({ status: 'duplicate', message: 'Same command as acp-fakebin.' });
    // A manual entry with the same command (bare name) also wins.
    const b = await buildAcpAgents(
      { presets: 'off', agents: [{ id: 'mine', command: ['fakebin', 'acp'], mcp: 'auto', enabled: true }] },
      { registry: registry(), allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache, handshake: async () => ({ status: 'available' }) },
    );
    expect(b.adapters.map((a) => a.id)).toEqual(['acp-mine']);
    expect(b.catalog.find((c) => c.registryId === 'fakebin')?.status).toBe('duplicate');
  });

  it('failed handshakes are cached for 24 h, timeouts never; stale keys are pruned', async () => {
    const p = await fakePath({ fakebin: 'acp' });
    let calls = 0;
    let answer: { status: 'error'; message: string } = { status: 'error', message: 'boom' };
    const handshake = async () => {
      calls++;
      return answer;
    };
    let now = new Date('2026-11-08T00:00:00Z');
    const o = { registry: registry(), config: base, allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache, handshake, now: () => now };
    await discoverAcpAgents(o);
    await discoverAcpAgents(o);
    expect(calls).toBe(1);
    now = new Date('2026-11-09T00:00:01Z');
    answer = { status: 'error', message: 'The agent did not answer initialize within 10000 ms.' };
    await discoverAcpAgents(o);
    expect(calls).toBe(2);
    await discoverAcpAgents(o);
    expect(calls).toBe(3);
    // A new binary at the same path: the old key is dropped.
    answer = { status: 'error', message: 'boom' };
    await writeFile(join(p.bin, 'fakebin'), '#!/bin/sh\nexit 4\n# v2\n');
    await discoverAcpAgents(o);
    const cache = JSON.parse(await readFile(join(p.cache, 'detect.json'), 'utf8')) as { handshakes: Record<string, unknown> };
    expect(Object.keys(cache.handshakes)).toHaveLength(1);
  });

  it('stopping a probe kills the agent\'s whole process group (no leftovers)', async () => {
    const p = await fakePath({});
    const pidFile = join(p.bin, '..', 'child.pid');
    await writeFile(join(p.bin, 'fakebin'), `#!/bin/sh\nsleep 60 &\necho $! > "${pidFile}"\nexec "${process.execPath}" "${fakeAcpPath}"\n`);
    await chmod(join(p.bin, 'fakebin'), 0o755);
    const r = await discoverAcpAgents({ registry: registry(), config: base, allowBypass: false, which: p.which, platform: hostPlatform(), cacheDir: p.cache });
    expect(r.adapters.map((a) => a.id)).toEqual(['acp-fakebin']);
    const child = Number(await readFile(pidFile, 'utf8'));
    expect(child).toBeGreaterThan(0);
    const alive = () => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((res) => setTimeout(res, 50));
    expect(alive()).toBe(false);
  });
});

describe('Windows commands (platform injected)', () => {
  async function winPath() {
    const root = await mkdtemp(join(tmpdir(), 'uncage-acp-win-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    await mkdir(join(bin, 'node_modules', '@google', 'gemini-cli', 'bundle'), { recursive: true });
    // npm's cmd-shim output for `gemini`, plus an extensionless file that CreateProcess would not run.
    await writeFile(
      join(bin, 'gemini.cmd'),
      '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js" %*\r\n',
    );
    await writeFile(join(bin, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'), '');
    await writeFile(join(bin, 'gemini'), '#!/bin/sh\n');
    await writeFile(join(bin, 'tool.bat'), '@echo off\r\n');
    await writeFile(join(bin, 'fakebin.exe'), '');
    await writeFile(join(bin, 'plain'), '');
    return { bin, which: createWhich({ PATH: `C:\\nowhere;${bin}`, PATHEXT: '.com;.exe;.bat;.cmd' }, 'win32') };
  }

  it('which searches PATHEXT extensions only', async () => {
    const w = await winPath();
    expect(await w.which('gemini')).toBe(join(w.bin, 'gemini.cmd'));
    expect(await w.which('fakebin')).toBe(join(w.bin, 'fakebin.exe'));
    expect(await w.which('plain')).toBeNull();
    expect(await w.which('gemini.cmd')).toBe(join(w.bin, 'gemini.cmd'));
  });

  it('npm .cmd shims run as node <script>; other .cmd/.bat via cmd.exe /d /s /c with strict quoting', async () => {
    const w = await winPath();
    const env = { SystemRoot: 'C:\\Windows' };
    const o = { which: w.which, platform: 'win32' as const, node: 'C:\\node\\node.exe', env };
    expect(await spawnableCommand(['gemini', '--acp'], o)).toEqual({ command: ['C:\\node\\node.exe', join(w.bin, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'), '--acp'] });
    expect(await spawnableCommand(['fakebin', 'acp'], o)).toEqual({ command: [join(w.bin, 'fakebin.exe'), 'acp'] });
    // Never a bare cmd.exe: the absolute one from SystemRoot, else a validated ComSpec.
    expect(await spawnableCommand(['tool', 'a b'], o)).toEqual({ command: ['C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', `""${join(w.bin, 'tool.bat')}" "a b""`] });
    const viaComSpec = await spawnableCommand(['tool'], { ...o, env: { ComSpec: 'D:\\Win\\System32\\cmd.exe' } });
    expect('command' in viaComSpec && viaComSpec.command[0]).toBe('D:\\Win\\System32\\cmd.exe');
    for (const bad of [{}, { ComSpec: 'cmd.exe' }, { ComSpec: 'C:\\evil\\payload.exe' }, { SystemRoot: 'Windows' }]) {
      expect(await spawnableCommand(['tool'], { ...o, env: bad })).toEqual({ error: expect.stringMatching(/cmd\.exe was not found/) });
    }
    expect(systemCmd({ SystemRoot: 'C:\\Windows', ComSpec: 'C:\\evil\\cmd.exe' })).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(await spawnableCommand(['tool', '%PATH%'], o)).toEqual({ error: expect.stringMatching(/cannot be passed safely/) });
    expect(await spawnableCommand(['tool', 'x" & calc'], o)).toEqual({ error: expect.stringMatching(/cannot be passed safely/) });
    expect(cmdLine(['a', 'b!'])).toBeUndefined();
    // Not on PATH: an error, never the bare name (Windows would search the current directory).
    expect(await spawnableCommand(['missing', 'acp'], o)).toEqual({ error: 'missing was not found on PATH.' });
    expect(relativeWindowsExecutable('gemini', 'win32')).toMatchObject({ code: 'ENOENT' });
    expect(relativeWindowsExecutable('C:\\x\\gemini.exe', 'win32')).toBeUndefined();
    expect(relativeWindowsExecutable('gemini', 'darwin')).toBeUndefined();
    // Not Windows: unchanged.
    expect(await spawnableCommand(['gemini', '--acp'], { which: w.which, platform: 'darwin' })).toEqual({ command: ['gemini', '--acp'] });
  });

  it('a manual entry not found on Windows is kept but never resolved from the current directory', async () => {
    const w = await winPath();
    const b = await buildAcpAgents(
      { presets: 'off', agents: [{ id: 'mine', command: ['missing', 'acp'], mcp: 'auto', enabled: true }] },
      { registry: { ...registry(), agents: [] }, allowBypass: false, which: w.which, platform: 'windows-x86_64', os: 'win32', env: { SystemRoot: 'C:\\Windows' } },
    );
    expect(b.adapters.map((a) => [a.id, a.command])).toEqual([['acp-mine', ['missing', 'acp']]]);
  });

  it('discovery on Windows: fakebin.exe detected, gemini from its npm shim', async () => {
    const w = await winPath();
    const r = await discoverAcpAgents({
      registry: { ...bundledRegistry(), agents: [...registry().agents, ...bundledRegistry().agents.filter((a) => a.id === 'gemini')] },
      config: base, allowBypass: false, which: w.which, platform: 'windows-x86_64', os: 'win32', cacheDir: join(w.bin, '..', 'cache'),
      handshake: async () => ({ status: 'available' }),
    });
    const byId = Object.fromEntries(r.adapters.map((a) => [a.id, a.command]));
    expect(byId['acp-fakebin']).toEqual([join(w.bin, 'fakebin.exe'), 'acp']);
    expect(byId['acp-gemini']).toEqual([process.execPath, join(w.bin, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'), '--acp']);
  });
});
