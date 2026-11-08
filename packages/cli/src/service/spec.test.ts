import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchdPlist, parsePlist } from './launchd.js';
import { parseTaskXml, taskXml } from './schtasks.js';
import { serviceSpec, servicePath } from './spec.js';
import { parseSystemdUnit, systemdUnit } from './systemd.js';
import type { ServiceSpec } from './types.js';

const cleanups: string[] = [];
afterEach(async () => {
  for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('serviceSpec', () => {
  // POSIX layout (colon-separated PATH, symlinked shims); the Windows case is below.
  it.skipIf(process.platform === 'win32')('serviceSpec pins realpath(process.execPath) and the real bin.js, never an fnm_multishells or volta shim path', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'uncage-spec-')));
    cleanups.push(root);
    const realNode = join(root, 'fnm', 'node-versions', 'v22.23.4', 'installation', 'bin', 'node');
    const realBin = join(root, 'lib', 'node_modules', '@uncage', 'cli', 'dist', 'bin.js');
    const shell = join(root, 'fnm_multishells', '12345_1700000000000', 'bin');
    const volta = join(root, '.volta', 'bin');
    await mkdir(join(realNode, '..'), { recursive: true });
    await mkdir(join(realBin, '..'), { recursive: true });
    await mkdir(shell, { recursive: true });
    await mkdir(volta, { recursive: true });
    await writeFile(realNode, '');
    await writeFile(realBin, '');
    // fnm's per-shell link and the npm bin link (`uncage` → bin.js) are symlinks.
    await symlink(realNode, join(shell, 'node'));
    await symlink(realBin, join(shell, 'uncage'));
    await symlink(realNode, join(volta, 'node'));

    const linux = await serviceSpec({
      home: '/home/u',
      execPath: join(shell, 'node'),
      argv1: join(shell, 'uncage'),
      env: { PATH: `${shell}:${volta}:/usr/bin:/bin:/usr/bin` },
      platform: 'linux',
    });
    expect(linux).toEqual({
      nodePath: realNode,
      cliEntry: realBin,
      args: ['agent'],
      env: { PATH: `${join(realNode, '..')}:${volta}:/usr/bin:/bin`, HOME: '/home/u' },
      workingDir: '/home/u',
      logsDir: '/home/u/.uncage/logs',
    });
    expect(linux.nodePath).not.toMatch(/fnm_multishells|\.volta/);
    expect((await serviceSpec({ home: '/h', execPath: join(volta, 'node'), argv1: realBin, env: {}, platform: 'linux' })).nodePath).toBe(realNode);
  });

  it('on Windows runs agent --supervise --log-file and keeps the Path (case-insensitive) with node first', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'uncage-spec-')));
    cleanups.push(root);
    await writeFile(join(root, 'node.exe'), '');
    await writeFile(join(root, 'bin.js'), '');
    const win = await serviceSpec({
      home: 'C:\\Users\\u',
      execPath: join(root, 'node.exe'),
      argv1: join(root, 'bin.js'),
      env: { Path: 'C:\\Windows\\system32;C:\\Users\\u\\AppData\\Local\\fnm_multishells\\1_2;C:\\WINDOWS\\System32' },
      platform: 'win32',
    });
    expect(win.args).toEqual(['agent', '--supervise', '--log-file', 'C:\\Users\\u\\.uncage\\logs\\agent.log']);
    expect(win.logsDir).toBe('C:\\Users\\u\\.uncage\\logs');
    expect(win.env.PATH.split(';').slice(1)).toEqual(['C:\\Windows\\system32']);
    expect(servicePath('/n/bin/node', {}, 'linux')).toBe('/n/bin:/usr/bin:/bin');
  });
});

describe('service definitions', () => {
  const awkward: ServiceSpec = {
    nodePath: '/home/a b/.local/share/fnm/node-versions/v22.23.4/installation/bin/node',
    cliEntry: '/home/a b/100% "real"/$HOME/lib/node_modules/@uncage/cli/dist/bin.js',
    args: ['agent'],
    env: { PATH: '/home/a b/bin:/usr/bin:/bin:/opt/50%/bin', HOME: '/home/a b' },
    workingDir: '/home/a b',
    logsDir: '/home/a b/.uncage/logs %h',
  };
  const awkwardWin: ServiceSpec = {
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliEntry: 'C:\\Users\\a b\\AppData\\Roaming\\npm\\node_modules\\@uncage\\cli\\dist\\bin.js',
    args: ['agent', '--log-file', 'C:\\Users\\a b\\.uncage\\logs\\agent.log'],
    env: { PATH: 'C:\\Program Files\\nodejs;C:\\100%\\bin', HOME: 'C:\\Users\\a b' },
    workingDir: 'C:\\Users\\a b',
    logsDir: 'C:\\Users\\a b\\.uncage\\logs',
  };

  it('launchd / systemd / schtasks definitions round-trip their spec (paths with spaces, %, quotes)', () => {
    const cases: Array<[(s: ServiceSpec) => string, (t: string) => ServiceSpec | null, ServiceSpec]> = [
      [launchdPlist, parsePlist, awkward],
      [systemdUnit, parseSystemdUnit, awkward],
      [(s) => taskXml(s, 'PC\\u'), parseTaskXml, awkwardWin],
      [(s) => taskXml(s, 'PC\\u'), parseTaskXml, { ...awkwardWin, cliEntry: 'C:\\odd "quoted"\\dir\\\\bin.js', nodePath: 'C:\\trailing\\' }],
      [(s) => taskXml(s, 'PC\\u', { headless: false }), parseTaskXml, awkwardWin],
    ];
    for (const [render, parse, spec] of cases) expect(parse(render(spec))).toEqual(spec);
  });
});
