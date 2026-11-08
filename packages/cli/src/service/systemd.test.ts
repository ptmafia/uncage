import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecFn } from '@uncage/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentService, detectServiceKind } from './index.js';
import { lingerEnabled, parseSystemdUnit, SYSTEMD_UNIT, systemdService, systemdUnit, systemdUnitPath } from './systemd.js';
import type { ServiceSpec } from './types.js';

const cleanups: string[] = [];
afterEach(async () => {
  for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmpHome(): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), 'uncage-systemd-'));
  cleanups.push(h);
  return h;
}
const spec = (home: string): ServiceSpec => ({
  nodePath: '/home/u/.local/share/fnm/node-versions/v22.23.4/installation/bin/node',
  cliEntry: '/home/u/.local/share/fnm/node-versions/v22.23.4/installation/lib/node_modules/@uncage/cli/dist/bin.js',
  args: ['agent'],
  env: { PATH: '/home/u/.local/share/fnm/node-versions/v22.23.4/installation/bin:/usr/bin:/bin', HOME: home },
  workingDir: home,
  logsDir: `${home}/.uncage/logs`,
});
const ok = (stdout = '') => ({ stdout, stderr: '' });

describe('systemd user unit', () => {
  it('is quoted, restarts on failure after 10 s, appends logs and starts with the user manager', () => {
    const unit = systemdUnit({ ...spec('/home/u'), cliEntry: '/opt/50% "x"/$HOME\\bin.js' });
    expect(unit).toContain('ExecStart="/home/u/.local/share/fnm/node-versions/v22.23.4/installation/bin/node" "/opt/50%% \\"x\\"/$$HOME\\\\bin.js" "agent"');
    expect(unit).toContain('\nRestart=on-failure\n');
    expect(unit).toContain('\nRestartSec=10\n');
    expect(unit).toContain('\nStandardOutput=append:/home/u/.uncage/logs/agent.log\n');
    expect(unit).toContain('\nStandardError=append:/home/u/.uncage/logs/agent.err.log\n');
    expect(unit).toContain('\nWorkingDirectory=/home/u\n');
    expect(unit).toContain('\nEnvironment="PATH=/home/u/.local/share/fnm/node-versions/v22.23.4/installation/bin:/usr/bin:/bin" "HOME=/home/u"\n');
    expect(unit).toMatch(/\[Install\]\nWantedBy=default\.target\n$/);
    expect(parseSystemdUnit('[Service]\nExecStart=/bin/true\n')).toBeNull();
  });

  it('lives in $XDG_CONFIG_HOME/systemd/user, else ~/.config/systemd/user', () => {
    expect(systemdUnitPath('/home/u', {})).toBe('/home/u/.config/systemd/user/uncage-agent.service');
    expect(systemdUnitPath('/home/u', { XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/systemd/user/uncage-agent.service');
    expect(systemdUnitPath('/home/u', { XDG_CONFIG_HOME: 'relative' })).toBe('/home/u/.config/systemd/user/uncage-agent.service');
  });

  it('systemd install: writes the unit, daemon-reload, enable --now; uninstall: disable --now, rm, daemon-reload', async () => {
    const home = await tmpHome();
    const exec = vi.fn<ExecFn>(async (file, args) => (file === 'loginctl' ? ok(`Linger=${args[1] === 'u' ? 'yes' : 'no'}\n`) : ok()));
    const svc = systemdService({ platform: 'linux', home, env: { USER: 'u' }, exec });
    const path = systemdUnitPath(home, {});
    expect(await svc.install(spec(home))).toEqual({ definitionPath: path, notes: [] });
    expect(exec.mock.calls).toEqual([
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]],
      ['loginctl', ['show-user', 'u', '-p', 'Linger']],
    ]);
    expect(parseSystemdUnit(await readFile(path, 'utf8'))).toEqual(spec(home));
    expect((await stat(join(home, '.uncage', 'logs'))).isDirectory()).toBe(true);

    // A re-install (e.g. after switching Node) also restarts the running agent.
    exec.mockClear();
    await svc.install(spec(home));
    expect(exec.mock.calls.slice(0, 3)).toEqual([
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]],
      ['systemctl', ['--user', 'restart', SYSTEMD_UNIT]],
    ]);

    exec.mockClear();
    expect(await svc.restart()).toBe(true);
    expect(exec.mock.calls).toEqual([['systemctl', ['--user', 'restart', SYSTEMD_UNIT]]]);

    exec.mockClear();
    expect(await svc.uninstall()).toEqual({ removed: true });
    expect(exec.mock.calls).toEqual([
      ['systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]],
      ['systemctl', ['--user', 'daemon-reload']],
    ]);
    await expect(stat(path)).rejects.toThrow();
    exec.mockClear();
    expect(await svc.uninstall()).toEqual({ removed: false });
    expect(await svc.restart()).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('install notes the linger hint when linger is off', async () => {
    const home = await tmpHome();
    const exec = vi.fn<ExecFn>(async (file) => (file === 'loginctl' ? ok('Linger=no\n') : ok()));
    const { notes } = await systemdService({ platform: 'linux', home, env: { USER: 'u' }, exec }).install(spec(home));
    expect(notes).toEqual(['The agent stops when you log out. To keep it running: loginctl enable-linger u']);
    expect(await lingerEnabled({ exec: async () => ok('Linger=yes'), env: { USER: 'u' } })).toBe(true);
    expect(
      await lingerEnabled({
        exec: async () => {
          throw new Error('no loginctl');
        },
        env: { USER: 'u' },
      }),
    ).toBeNull();
  });

  it('agent status reports the pinned Node and whether it still exists', async () => {
    const home = await tmpHome();
    let active = true;
    const exec = vi.fn<ExecFn>(async (file, args) => {
      if (file === 'systemctl' && args[1] === 'is-active') {
        if (active) return ok('active\n');
        throw Object.assign(new Error('exit 3'), { stdout: 'failed\n' });
      }
      if (file === process.execPath) return ok('v22.23.4\n');
      return ok();
    });
    const svc = systemdService({ platform: 'linux', home, env: {}, exec });
    expect(await svc.status()).toMatchObject({ kind: 'systemd', installed: false, running: false, spec: null });
    const s = { ...spec(home), nodePath: process.execPath };
    await svc.install(s);
    expect(await svc.status()).toEqual({
      kind: 'systemd',
      installed: true,
      running: true,
      spec: s,
      nodeExists: true,
      nodeVersion: 'v22.23.4',
      definitionPath: systemdUnitPath(home, {}),
    });
    active = false;
    await svc.install({ ...s, nodePath: join(home, 'removed', 'node') });
    expect(await svc.status()).toMatchObject({ running: false, detail: 'failed', nodeExists: false, nodeVersion: null });
  });
});

describe('detectServiceKind', () => {
  it('darwin launchd, win32 schtasks; linux systemd only when systemctl --user show-environment works', async () => {
    const works = vi.fn<ExecFn>(async () => ok('HOME=/home/u\n'));
    const fails = vi.fn<ExecFn>(async () => {
      throw Object.assign(new Error('Failed to connect to bus: No medium found'), { code: 1 });
    });
    const base = { home: '/home/u', env: {} };
    expect(await detectServiceKind({ ...base, platform: 'darwin', exec: fails })).toBe('launchd');
    expect(await detectServiceKind({ ...base, platform: 'win32', exec: fails })).toBe('schtasks');
    expect(await detectServiceKind({ ...base, platform: 'linux', exec: works })).toBe('systemd');
    expect(works).toHaveBeenCalledWith('systemctl', ['--user', 'show-environment']);
    expect(await detectServiceKind({ ...base, platform: 'linux', exec: fails })).toBe('none');
    expect(await detectServiceKind({ ...base, platform: 'freebsd', exec: works })).toBe('none');
    const none = await agentService({ ...base, platform: 'linux', exec: fails });
    expect(none.kind).toBe('none');
    expect((await none.install(spec('/home/u'))).notes[0]).toMatch(/uncage agent$/);
    expect(await none.status()).toMatchObject({ kind: 'none', installed: false, running: null });
  });
});
