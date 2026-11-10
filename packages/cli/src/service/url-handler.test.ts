import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import type { ExecFn } from '@uncage/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceSpec } from './types.js';
import {
  appleScriptSource,
  desktopEntry,
  LSREGISTER,
  macAppPath,
  patchInfoPlist,
  registerUrlHandler,
  unregisterUrlHandler,
  windowsCommand,
} from './url-handler.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
});

async function tmpHome(): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), 'uncage-urlh-'));
  cleanups.push(() => rm(h, { recursive: true, force: true }));
  return h;
}

/**
 * A temp home written with forward slashes: the macOS / Linux code paths build POSIX paths whatever
 * the host, and Windows accepts `C:/…` too, so these tests run the same on every runner.
 */
async function posixHome(): Promise<string> {
  return (await tmpHome()).replace(/\\/g, '/');
}

const spec = (home: string, o: Partial<ServiceSpec> = {}): ServiceSpec => ({
  nodePath: '/opt/node 22/bin/node',
  cliEntry: "/usr/local/lib/node_modules/@uncage/cli/dist/bin.js",
  args: ['agent'],
  env: { PATH: '/opt/node 22/bin:/usr/bin:/bin', HOME: home },
  workingDir: home,
  logsDir: `${home}/.uncage/logs`,
  ...o,
});

/** What osacompile writes into a fresh applet's Info.plist (trimmed). */
const OSACOMPILE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>applet</string>
	<key>CFBundleIdentifier</key>
	<string>com.apple.ScriptEditor.id.UncageConnect</string>
	<key>CFBundleName</key>
	<string>UncageConnect</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
</dict>
</plist>
`;

/** A fake exec where `osacompile -o <app> <src>` creates a bundle like the real one. */
function macExec() {
  return vi.fn<ExecFn>(async (file, args) => {
    if (file === '/usr/bin/osacompile') {
      const app = args[args.indexOf('-o') + 1]!;
      await mkdir(posix.join(app, 'Contents', 'MacOS'), { recursive: true });
      await writeFile(posix.join(app, 'Contents', 'Info.plist'), OSACOMPILE_PLIST);
      await writeFile(posix.join(app, 'Contents', 'MacOS', 'applet'), '');
    }
    return { stdout: '', stderr: '' };
  });
}

describe('macOS handler', () => {
  it('the applet handles `open location` and runs the pinned Node + CLI connect with the URL shell-quoted, in the background', () => {
    const src = appleScriptSource(spec('/Users/me'));
    expect(src).toMatch(/^on open location theURL$/m);
    expect(src).toContain('quoted form of theURL');
    expect(src).toContain(`'/opt/node 22/bin/node' '/usr/local/lib/node_modules/@uncage/cli/dist/bin.js' connect --from-link `);
    // The logs folder is created first (M7), then the command runs in the background.
    expect(src).toContain(`/bin/mkdir -p '/Users/me/.uncage/logs'; `);
    expect(src).toContain(`>> '/Users/me/.uncage/logs/connect.log' 2>&1 &`);
    expect(src.indexOf('/bin/mkdir')).toBeLessThan(src.indexOf('connect.log'));
    expect(src).toMatch(/^on run$/m);
    // A path with quotes is escaped for the shell, then for the AppleScript string.
    const odd = appleScriptSource(spec('/Users/me', { nodePath: `/opt/it's "n"\\node` }));
    expect(odd).toContain(String.raw`'/opt/it'\\''s \"n\"\\node'`);
  });

  it('patchInfoPlist sets the bundle id, the uncage URL scheme and hides the Dock icon', () => {
    const out = patchInfoPlist(OSACOMPILE_PLIST, 'uncage');
    expect(out).toContain('<key>CFBundleIdentifier</key>\n\t<string>dev.uncage.connect</string>');
    expect(out).not.toContain('com.apple.ScriptEditor');
    expect(out).toMatch(/<key>CFBundleURLTypes<\/key>\s*<array>\s*<dict>\s*<key>CFBundleURLName<\/key>\s*<string>dev\.uncage\.connect<\/string>\s*<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>uncage<\/string>/);
    expect(out).toMatch(/<key>LSUIElement<\/key>\s*<true\/>/);
    expect(out.trimEnd().endsWith('</dict>\n</plist>')).toBe(true);
    expect(patchInfoPlist(out, 'uncage')).toBe(out); // idempotent
  });

  it('register writes ~/Library/Application Support/Uncage/UncageConnect.app (osacompile), re-signs and registers it with lsregister -f', async () => {
    const home = await posixHome();
    const exec = macExec();
    const r = await registerUrlHandler({ platform: 'darwin', home, exec, spec: spec(home) });
    const app = macAppPath(home);
    expect(app).toBe(posix.join(home, 'Library', 'Application Support', 'Uncage', 'UncageConnect.app'));
    expect(r).toEqual({ registered: true, location: app, notes: [] });
    const calls = exec.mock.calls.map(([f, a]) => [f, ...a]);
    expect(calls[0]).toEqual(['/usr/bin/osacompile', '-o', app, posix.join(home, 'Library', 'Application Support', 'Uncage', 'UncageConnect.applescript')]);
    expect(calls[1]).toEqual(['/usr/bin/codesign', '--force', '--sign', '-', app]);
    expect(calls[2]).toEqual(['/usr/bin/codesign', '--verify', app]);
    expect(calls[3]).toEqual([LSREGISTER, '-f', app]);
    expect(LSREGISTER).toBe('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister');
    const plist = await readFile(posix.join(app, 'Contents', 'Info.plist'), 'utf8');
    expect(plist).toContain('<string>dev.uncage.connect</string>');
    expect(plist).toContain('<string>uncage</string>');
    const src = await readFile(posix.join(home, 'Library', 'Application Support', 'Uncage', 'UncageConnect.applescript'), 'utf8');
    expect(src).toContain('on open location theURL');
  });

  it('a failing re-sign or signature check reports not registered and never calls lsregister', async () => {
    for (const failing of [['--force', '--sign', '-'], ['--verify']]) {
      const home = await posixHome();
      const inner = macExec();
      const exec = vi.fn<ExecFn>(async (file, args) => {
        if (file === '/usr/bin/codesign' && failing.every((a, i) => args[i] === a)) throw Object.assign(new Error('x'), { stderr: 'invalid signature' });
        return inner(file, args);
      });
      const r = await registerUrlHandler({ platform: 'darwin', home, exec, spec: spec(home) });
      expect(r.registered).toBe(false);
      expect(r.notes.join('\n')).toContain('invalid signature');
      expect(exec).not.toHaveBeenCalledWith(LSREGISTER, expect.anything());
    }
  });

  it('unregister unregisters from LaunchServices and removes the bundle', async () => {
    const home = await posixHome();
    const exec = macExec();
    await registerUrlHandler({ platform: 'darwin', home, exec, spec: spec(home) });
    exec.mockClear();
    expect(await unregisterUrlHandler({ platform: 'darwin', home, exec })).toEqual({ removed: true });
    expect(exec).toHaveBeenCalledWith(LSREGISTER, ['-u', macAppPath(home)]);
    await expect(access(macAppPath(home))).rejects.toThrow();
    await expect(access(posix.join(home, 'Library', 'Application Support', 'Uncage', 'UncageConnect.applescript'))).rejects.toThrow();
    expect(await unregisterUrlHandler({ platform: 'darwin', home, exec })).toEqual({ removed: false });
  });

  it('a failing osacompile reports not registered (with a note) and leaves no half bundle registered', async () => {
    const home = await posixHome();
    const exec = vi.fn<ExecFn>(async (file) => {
      if (file === '/usr/bin/osacompile') throw Object.assign(new Error('boom'), { stderr: 'syntax error' });
      return { stdout: '', stderr: '' };
    });
    const r = await registerUrlHandler({ platform: 'darwin', home, exec, spec: spec(home) });
    expect(r.registered).toBe(false);
    expect(r.notes.join('\n')).toContain('syntax error');
    expect(exec).not.toHaveBeenCalledWith(LSREGISTER, expect.anything());
  });
});

describe('Linux handler', () => {
  it('desktopEntry: Exec=<node> <cli> connect --from-link %u (quoted per the Desktop Entry spec), MimeType, NoDisplay', () => {
    const e = desktopEntry(spec('/home/me', { nodePath: '/usr/bin/node' }), 'uncage');
    expect(e).toContain('\nExec=/usr/bin/node /usr/local/lib/node_modules/@uncage/cli/dist/bin.js connect --from-link %u\n');
    expect(e).toContain('\nMimeType=x-scheme-handler/uncage;\n');
    expect(e).toContain('\nNoDisplay=true\n');
    expect(e).toContain('\nTerminal=false\n');
    expect(e.startsWith('[Desktop Entry]\n')).toBe(true);
    const q = desktopEntry(spec('/home/me', { nodePath: '/opt/my node/100%/$x`"\\node' }), 'uncage');
    expect(q).toContain(String.raw`Exec="/opt/my node/100%%/\\$x\\` + '`' + String.raw`\\"\\\\node" `);
    expect(() => desktopEntry(spec('/home/me', { cliEntry: '/a\nb' }), 'uncage')).toThrow(/line break/);
  });

  it('register writes $XDG_DATA_HOME/applications/uncage-connect.desktop and runs xdg-mime default', async () => {
    const home = await posixHome();
    const data = posix.join(home, 'xdg-data');
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' }));
    const findCommand = vi.fn(async (c: string) => (c === 'xdg-mime' ? '/usr/bin/xdg-mime' : null));
    const r = await registerUrlHandler({ platform: 'linux', home, exec, spec: spec(home), env: { XDG_DATA_HOME: data }, findCommand });
    const file = posix.join(data, 'applications', 'uncage-connect.desktop');
    expect(r).toEqual({ registered: true, location: file, notes: [] });
    expect(await readFile(file, 'utf8')).toContain('MimeType=x-scheme-handler/uncage;');
    expect(exec).toHaveBeenCalledWith('/usr/bin/xdg-mime', ['default', 'uncage-connect.desktop', 'x-scheme-handler/uncage']);
  });

  it('without XDG_DATA_HOME uses ~/.local/share; without xdg-mime writes the file and notes it', async () => {
    const home = await posixHome();
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' }));
    const r = await registerUrlHandler({ platform: 'linux', home, exec, spec: spec(home), env: { XDG_DATA_HOME: 'relative/ignored' }, findCommand: async () => null });
    const file = posix.join(home, '.local', 'share', 'applications', 'uncage-connect.desktop');
    expect(r.location).toBe(file);
    expect(r.registered).toBe(false);
    expect(r.notes.join('\n')).toMatch(/xdg-mime/);
    expect((await stat(file)).isFile()).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('unregister removes the .desktop file and our default in mimeapps.list (other lines kept)', async () => {
    const home = await posixHome();
    const env = { XDG_DATA_HOME: posix.join(home, 'd'), XDG_CONFIG_HOME: posix.join(home, 'c') };
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' }));
    await registerUrlHandler({ platform: 'linux', home, exec, spec: spec(home), env, findCommand: async () => '/usr/bin/xdg-mime' });
    await mkdir(posix.join(home, 'c'), { recursive: true });
    await writeFile(
      posix.join(home, 'c', 'mimeapps.list'),
      '[Default Applications]\nx-scheme-handler/uncage=uncage-connect.desktop\ntext/html=firefox.desktop\nx-scheme-handler/other=uncage-connect.desktop\n',
    );
    expect(await unregisterUrlHandler({ platform: 'linux', home, exec, env })).toEqual({ removed: true });
    await expect(access(posix.join(home, 'd', 'applications', 'uncage-connect.desktop'))).rejects.toThrow();
    expect(await readFile(posix.join(home, 'c', 'mimeapps.list'), 'utf8')).toBe(
      '[Default Applications]\ntext/html=firefox.desktop\nx-scheme-handler/other=uncage-connect.desktop\n',
    );
    expect(await unregisterUrlHandler({ platform: 'linux', home, exec, env })).toEqual({ removed: false });
  });
});

it('Linux unregister: mimeapps.list with CRLF line endings loses only our line', async () => {
  const home = await posixHome();
  const env = { XDG_DATA_HOME: posix.join(home, 'd'), XDG_CONFIG_HOME: posix.join(home, 'c') };
  await mkdir(posix.join(home, 'c'), { recursive: true });
  await writeFile(posix.join(home, 'c', 'mimeapps.list'), '[Default Applications]\r\nx-scheme-handler/uncage=uncage-connect.desktop\r\ntext/html=firefox.desktop\r\n');
  await unregisterUrlHandler({ platform: 'linux', home, exec: vi.fn<ExecFn>(), env });
  expect(await readFile(posix.join(home, 'c', 'mimeapps.list'), 'utf8')).toBe('[Default Applications]\r\ntext/html=firefox.desktop\r\n');
});

describe('Windows handler', () => {
  const winSpec = (home: string) => spec(home, { nodePath: 'C:\\Program Files\\nodejs\\node.exe', cliEntry: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@uncage\\cli\\dist\\bin.js' });

  it('windowsCommand quotes node, cli and %1 (connect --from-link)', () => {
    expect(windowsCommand(winSpec('C:\\Users\\me'))).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@uncage\\cli\\dist\\bin.js" connect --from-link "%1"',
    );
    expect(() => windowsCommand(spec('C:\\x', { nodePath: 'C:\\a"b\\node.exe' }))).toThrow();
  });

  it('register: reg add HKCU\\Software\\Classes\\uncage (URL Protocol, shell\\open\\command) via systemTool', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' }));
    const s = winSpec('C:\\Users\\me');
    const r = await registerUrlHandler({ platform: 'win32', home: 'C:\\Users\\me', exec, spec: s, env: { SystemRoot: 'C:\\Windows' } });
    const reg = 'C:\\Windows\\System32\\reg.exe';
    expect(r).toEqual({ registered: true, location: 'HKCU\\Software\\Classes\\uncage', notes: [] });
    expect(exec.mock.calls).toEqual([
      [reg, ['add', 'HKCU\\Software\\Classes\\uncage', '/ve', '/d', 'URL:Uncage Connect', '/f']],
      [reg, ['add', 'HKCU\\Software\\Classes\\uncage', '/v', 'URL Protocol', '/d', '', '/f']],
      [reg, ['add', 'HKCU\\Software\\Classes\\uncage\\shell\\open\\command', '/ve', '/d', windowsCommand(s), '/f']],
    ]);
  });

  it('unregister: reg delete the key (absent → removed: false)', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '' }));
    expect(await unregisterUrlHandler({ platform: 'win32', home: 'C:\\Users\\me', exec, env: { SystemRoot: 'C:\\Windows' } })).toEqual({ removed: true });
    expect(exec).toHaveBeenCalledWith('C:\\Windows\\System32\\reg.exe', ['delete', 'HKCU\\Software\\Classes\\uncage', '/f']);
    const missing = vi.fn<ExecFn>(async () => {
      throw new Error('not found');
    });
    expect(await unregisterUrlHandler({ platform: 'win32', home: 'C:\\Users\\me', exec: missing, env: {} })).toEqual({ removed: false });
  });

  it('a failing reg add reports not registered', async () => {
    const exec = vi.fn<ExecFn>(async () => {
      throw Object.assign(new Error('denied'), { stderr: 'ERROR: Access is denied.' });
    });
    const r = await registerUrlHandler({ platform: 'win32', home: 'C:\\Users\\me', exec, spec: winSpec('C:\\Users\\me'), env: {} });
    expect(r.registered).toBe(false);
    expect(r.notes.join('\n')).toContain('Access is denied');
  });
});

it('other platforms: nothing to register', async () => {
  const exec = vi.fn<ExecFn>();
  expect(await registerUrlHandler({ platform: 'freebsd', home: '/home/me', exec, spec: spec('/home/me') })).toEqual({ registered: false, location: '', notes: [expect.any(String)] });
  expect(await unregisterUrlHandler({ platform: 'freebsd', home: '/home/me', exec })).toEqual({ removed: false });
  expect(exec).not.toHaveBeenCalled();
});

/**
 * The REAL registration, on a CI runner only (CI + UNCAGE_URL_HANDLER_TESTS=1; never on a developer
 * machine). It uses a throwaway scheme (`uncage-ci-<random>`), a temp home (macOS bundle, Linux XDG
 * folders) and a fake CLI that records its arguments; everything is removed afterwards.
 */
const real = !!process.env.CI && process.env.UNCAGE_URL_HANDLER_TESTS === '1';
const run = promisify(execFile);

/** One GitHub annotation (shows on the check run even when the log cannot be read). */
function annotate(level: 'error' | 'warning' | 'notice', title: string, text: string): void {
  console.log(`::${level} title=${title}::${text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
}

interface Call {
  cmd: string;
  ms: number;
  ok: boolean;
  code?: unknown;
  signal?: unknown;
  stdout?: string;
  stderr?: string;
}

const clip = (t: string | undefined, n = 1500): string => (t && t.length > n ? `${t.slice(0, n)}…(${t.length} chars)` : (t ?? ''));

/** A real exec with a per-call timeout that records every call (exit code, signal, output) for diagnostics. */
function recordingExec(log: Call[], o: { timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): ExecFn {
  return async (file, args) => {
    const t0 = Date.now();
    const cmd = [file, ...args].join(' ');
    try {
      const r = await run(file, args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: o.timeoutMs ?? 30_000,
        maxBuffer: o.maxBuffer ?? 16 * 1024 * 1024,
        ...(o.env ? { env: o.env } : {}),
      });
      log.push({ cmd, ms: Date.now() - t0, ok: true, stdout: clip(r.stdout, 300), stderr: clip(r.stderr, 300) });
      return { stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      const x = e as { code?: unknown; signal?: unknown; stdout?: string; stderr?: string; killed?: boolean };
      log.push({ cmd, ms: Date.now() - t0, ok: false, code: x.code, signal: x.signal ?? (x.killed ? 'killed (timeout)' : undefined), stdout: clip(x.stdout), stderr: clip(x.stderr) });
      throw e;
    }
  };
}

const formatCalls = (log: Call[]): string =>
  log
    .map((c) => `${c.ok ? 'ok ' : 'ERR'} ${c.ms}ms ${c.cmd}${c.ok ? '' : ` code=${String(c.code)} signal=${String(c.signal)}`}${c.stderr ? `\n    stderr: ${c.stderr}` : ''}${!c.ok && c.stdout ? `\n    stdout: ${c.stdout}` : ''}`)
    .join('\n');

/** Runs `fn`; on failure prints the calls and `extra()` diagnostics as one ::error:: annotation, then rethrows. */
async function diagnosed(title: string, log: Call[], extra: () => Promise<string>, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const more = await extra().catch((x: unknown) => `(diagnostics failed: ${String(x)})`);
    annotate('error', title, `${e instanceof Error ? e.message : String(e)}\n\ncalls:\n${formatCalls(log)}\n\n${more}`);
    throw e;
  }
}

async function waitForFile(path: string, ms: number): Promise<string | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await readFile(path, 'utf8').catch(() => null);
    if (t) return t;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

describe.runIf(real)('real registration (CI runner only)', () => {
  const scheme = `uncage-ci-${Math.random().toString(36).slice(2, 10)}`;

  async function fakeCli(home: string): Promise<{ cliEntry: string; argsFile: string }> {
    const dir = join(home, 'fake-cli');
    await mkdir(dir, { recursive: true });
    const argsFile = join(dir, 'args.json');
    const cliEntry = join(dir, 'bin.js');
    await writeFile(cliEntry, `require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n`);
    await chmod(cliEntry, 0o755);
    return { cliEntry, argsFile };
  }

  /**
   * macOS. Hard checks: osacompile builds the applet, Info.plist declares the scheme, the re-signed
   * bundle verifies, and LaunchServices lists our bundle for the scheme (`lsregister -dump`). Soft
   * check: `open <scheme>://…` reaching the applet through Apple Events (reported as a notice or
   * warning: GUI delivery to a freshly built applet on a CI runner is not guaranteed).
   */
  it.runIf(process.platform === 'darwin')('macOS: applet built, signed and registered for the scheme; URL delivery reported', async () => {
    const title = 'url-handler macOS';
    const log: Call[] = [];
    const exec = recordingExec(log);
    const home = await realpath(await tmpHome());
    const app = macAppPath(home);
    const { cliEntry, argsFile } = await fakeCli(home);
    const s = spec(home, { nodePath: await realpath(process.execPath), cliEntry });
    cleanups.push(async () => void (await unregisterUrlHandler({ platform: 'darwin', home, exec: recordingExec([], { timeoutMs: 20_000 }) })));
    const extra = async () => {
      const plist = await readFile(join(app, 'Contents', 'Info.plist'), 'utf8').catch((e: unknown) => `(no Info.plist: ${String(e)})`);
      const sig = await run('/usr/bin/codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8', timeout: 20_000 }).then(
        (r) => r.stderr,
        (e: { stderr?: string }) => `codesign -dv failed: ${e.stderr ?? String(e)}`,
      );
      const connectLog = await readFile(join(s.logsDir, 'connect.log'), 'utf8').catch(() => '(no connect.log)');
      return `Info.plist:\n${clip(plist, 3000)}\n\ncodesign -dv:\n${clip(sig)}\n\nconnect.log:\n${clip(connectLog)}`;
    };
    await diagnosed(title, log, extra, async () => {
      await mkdir(s.logsDir, { recursive: true });
      const r = await registerUrlHandler({ platform: 'darwin', home, exec, spec: s, scheme });
      expect(r).toEqual({ registered: true, location: app, notes: [] });
      const plist = await readFile(join(app, 'Contents', 'Info.plist'), 'utf8');
      expect(plist).toContain('<string>dev.uncage.connect</string>');
      expect(plist).toContain(`<string>${scheme}</string>`);
      expect(plist).toContain('<key>CFBundleExecutable</key>');
      await exec('/usr/bin/codesign', ['--verify', '--deep', app]);
      // LaunchServices knows our bundle for the scheme.
      const dump = await recordingExec(log, { timeoutMs: 60_000, maxBuffer: 512 * 1024 * 1024 })(LSREGISTER, ['-dump']);
      const records = dump.stdout.split(/\n-{10,}\n/);
      const ours = records.filter((rec) => rec.includes(scheme));
      log.push({ cmd: `lsregister -dump: ${records.length} records, ${ours.length} mention ${scheme}`, ms: 0, ok: true, stdout: clip(ours.join('\n=====\n'), 2000) });
      expect(ours.some((rec) => rec.includes('UncageConnect.app'))).toBe(true);
    });

    // Soft: delivery through Apple Events (30 s budget).
    const url = `${scheme}://connect?url=${encodeURIComponent('https://example.com')}`;
    const opened = await exec('/usr/bin/open', [url]).then(
      () => true,
      () => false,
    );
    const got = opened ? await waitForFile(argsFile, 30_000) : null;
    if (got && JSON.stringify(JSON.parse(got)) === JSON.stringify(['connect', '--from-link', url])) annotate('notice', title, `applet received: ${got}`);
    else annotate('warning', title, `URL not delivered to the applet within 30 s (open ${opened ? 'ok' : 'failed'}; got ${got ?? 'nothing'}). Registration itself is verified.\n\ncalls:\n${formatCalls(log)}\n\n${await extra()}`);
  }, 180_000);

  it.runIf(process.platform === 'win32')('Windows: a throwaway HKCU\\Software\\Classes key is written, launched and deleted', async () => {
    const title = 'url-handler Windows';
    const log: Call[] = [];
    const exec = recordingExec(log);
    const reg = 'C:\\Windows\\System32\\reg.exe';
    const home = await tmpHome();
    const { cliEntry, argsFile } = await fakeCli(home);
    const s = spec(home, { nodePath: process.execPath, cliEntry });
    const key = `HKCU\\Software\\Classes\\${scheme}`;
    cleanups.push(async () => void (await unregisterUrlHandler({ platform: 'win32', home, exec: recordingExec([]), scheme })));
    const extra = async () =>
      run(reg, ['query', key, '/s'], { encoding: 'utf8', timeout: 20_000 }).then(
        (r) => `reg query ${key} /s:\n${r.stdout}`,
        (e: { stderr?: string }) => `reg query ${key} failed: ${e.stderr ?? String(e)}`,
      );
    await diagnosed(title, log, extra, async () => {
      const r = await registerUrlHandler({ platform: 'win32', home, exec, spec: s, scheme });
      expect(r).toEqual({ registered: true, location: key, notes: [] });
      const { stdout } = await exec(reg, ['query', `${key}\\shell\\open\\command`, '/ve']);
      expect(stdout).toContain(windowsCommand(s));
      const url = `${scheme}://connect?url=${encodeURIComponent('https://example.com')}`;
      await exec('C:\\Windows\\System32\\rundll32.exe', ['url.dll,FileProtocolHandler', url]);
      const got = await waitForFile(argsFile, 45_000);
      annotate(got ? 'notice' : 'error', title, `handler received: ${got ?? '(nothing within 45 s)'}`);
      expect(got && JSON.parse(got)[0]).toBe('connect');
      expect(await unregisterUrlHandler({ platform: 'win32', home, exec, scheme })).toEqual({ removed: true });
      await expect(exec(reg, ['query', key])).rejects.toThrow();
    });
  }, 120_000);

  it.runIf(process.platform === 'linux')('Linux: the .desktop file in a temp XDG_DATA_HOME becomes the xdg-mime default', async () => {
    const title = 'url-handler Linux';
    const log: Call[] = [];
    const home = await tmpHome();
    const env = { ...process.env, XDG_DATA_HOME: join(home, 'data'), XDG_CONFIG_HOME: join(home, 'config') };
    // xdg-mime reads the XDG folders from its environment.
    const exec = recordingExec(log, { env });
    const file = join(home, 'data', 'applications', 'uncage-connect.desktop');
    await diagnosed(title, log, async () => `desktop file:\n${await readFile(file, 'utf8').catch(() => '(missing)')}`, async () => {
      await mkdir(env.XDG_CONFIG_HOME, { recursive: true });
      const xdgMime = await exec('/bin/sh', ['-c', 'command -v xdg-mime || true']).then((r) => r.stdout.trim());
      if (!xdgMime) annotate('notice', title, 'xdg-mime not installed on this runner; only the file is checked');
      const s = spec(home, { nodePath: process.execPath, cliEntry: join(home, 'bin.js') });
      const r = await registerUrlHandler({ platform: 'linux', home, exec, spec: s, env, scheme });
      expect(r.location).toBe(file);
      expect(await readFile(file, 'utf8')).toContain(`MimeType=x-scheme-handler/${scheme};`);
      if (xdgMime) {
        expect(r.registered).toBe(true);
        const q = await exec(xdgMime, ['query', 'default', `x-scheme-handler/${scheme}`]);
        expect(q.stdout.trim()).toBe('uncage-connect.desktop');
      }
      expect(await unregisterUrlHandler({ platform: 'linux', home, exec, env, scheme })).toEqual({ removed: true });
      await expect(access(file)).rejects.toThrow();
    });
  }, 60_000);
});
