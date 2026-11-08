import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecFn } from '@uncage/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchdPlist, launchdService, parsePlist, plistPath } from './launchd.js';
import type { ServiceSpec } from './types.js';

/** The exact plist the pre-0.3 `installLaunchAgent` wrote for these inputs (generated from the old code). */
const GOLDEN = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.uncage.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/@uncage/cli/dist/bin.js</string>
    <string>agent</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>/Users/me</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/me</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/me/.uncage/logs/agent.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/me/.uncage/logs/agent.err.log</string>
</dict>
</plist>
`;

const cleanups: string[] = [];
afterEach(async () => {
  for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
});

const spec = (home: string): ServiceSpec => ({
  nodePath: '/usr/local/bin/node',
  cliEntry: '/usr/local/lib/node_modules/@uncage/cli/dist/bin.js',
  args: ['agent'],
  env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home },
  workingDir: home,
  logsDir: `${home}/.uncage/logs`,
});

describe('launchd', () => {
  it('writes byte-for-byte the plist the old installLaunchAgent wrote', () => {
    expect(launchdPlist(spec('/Users/me'))).toBe(GOLDEN);
    expect(parsePlist(GOLDEN)).toEqual(spec('/Users/me'));
    expect(parsePlist('<plist/>')).toBeNull();
  });

  it('status reads the pinned spec back, asks launchctl print whether it runs, and checks the pinned Node', async () => {
    const home = await mkdtemp(join(tmpdir(), 'uncage-launchd-'));
    cleanups.push(home);
    const exec = vi.fn<ExecFn>(async (file, args) => {
      if (file === 'launchctl' && args[0] === 'print') return { stdout: 'gui/501/dev.uncage.agent = {\n\tstate = running\n\tpid = 4242\n}', stderr: '' };
      if (file === process.execPath) return { stdout: 'v22.23.4\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const svc = launchdService({ platform: 'darwin', home, env: {}, exec, uid: 501 });
    expect(await svc.status()).toMatchObject({ kind: 'launchd', installed: false, running: false, spec: null, nodeExists: null });
    const s = { ...spec(home), nodePath: process.execPath };
    await svc.install(s);
    expect(await svc.status()).toEqual({
      kind: 'launchd',
      installed: true,
      running: true,
      spec: s,
      nodeExists: true,
      nodeVersion: 'v22.23.4',
      definitionPath: plistPath(home),
      detail: 'pid 4242',
    });
    expect(exec).toHaveBeenCalledWith('launchctl', ['print', 'gui/501/dev.uncage.agent']);
    // The pinned Node was removed (e.g. an nvm version uninstalled).
    await writeFile(plistPath(home), launchdPlist({ ...s, nodePath: join(home, 'gone', 'node') }));
    expect(await svc.status()).toMatchObject({ installed: true, nodeExists: false, nodeVersion: null });
  });
});
