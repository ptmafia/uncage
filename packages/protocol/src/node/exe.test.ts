import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdLine, findCommand, isCmdLine, isSystemTool, parseNpmCmdShim, resolveCommand, safeExecFile, systemCmd, systemTool, UnsafeCommandError } from './exe.js';

// CI runs this file on ubuntu, macos and windows (the platform is injected where it matters).

const cleanups: string[] = [];
afterEach(async () => {
  for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'uncage exe '));
  cleanups.push(d);
  return d;
}

/** The shim npm (cmd-shim 6) writes for a JS bin. */
const NODE_SHIM = (rel: string) => `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
\r
IF EXIST "%dp0%\\node.exe" (\r
  SET "_prog=%dp0%\\node.exe"\r
) ELSE (\r
  SET "_prog=node"\r
  SET PATHEXT=%PATHEXT:;.JS;=;%\r
)\r
\r
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r
`;
/** The shim npm writes for a native (.exe) bin. */
const EXE_SHIM = (rel: string) => `@ECHO off\r
GOTO start\r
:find_dp0\r
SET dp0=%~dp0\r
EXIT /b\r
:start\r
SETLOCAL\r
CALL :find_dp0\r
"%dp0%\\${rel}"   %*\r
`;
/** The older cmd-shim layout. */
const OLD_SHIM = (rel: string) => `@IF EXIST "%~dp0\\node.exe" (\r
  "%~dp0\\node.exe"  "%~dp0\\${rel}" %*\r
) ELSE (\r
  @SETLOCAL\r
  @SET PATHEXT=%PATHEXT:;.JS;=;%\r
  node  "%~dp0\\${rel}" %*\r
)\r
`;

describe('parseNpmCmdShim', () => {
  it('reads the JS or exe target of current and older npm shims; null for other batch files', () => {
    expect(parseNpmCmdShim(NODE_SHIM('node_modules\\@openai\\codex\\bin\\codex.js'))).toEqual({
      target: 'node_modules\\@openai\\codex\\bin\\codex.js',
      viaNode: true,
    });
    expect(parseNpmCmdShim(EXE_SHIM('node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'))).toEqual({
      target: 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
      viaNode: false,
    });
    expect(parseNpmCmdShim(OLD_SHIM('node_modules\\x\\cli.js'))).toEqual({ target: 'node_modules\\x\\cli.js', viaNode: true });
    expect(parseNpmCmdShim('@echo off\r\necho hello %*\r\n')).toBeNull();
    expect(parseNpmCmdShim('')).toBeNull();
  });
});

describe('resolveCommand', () => {
  it('on win32 (fixture PATH): claude.exe first, an npm codex.cmd becomes node + codex.js, unknown → null', async () => {
    const root = await tmp();
    const a = join(root, 'bin a');
    const npm = join(root, 'npm');
    await mkdir(a, { recursive: true });
    await mkdir(join(npm, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    await writeFile(join(a, 'claude.cmd'), EXE_SHIM('nope.exe'));
    await writeFile(join(a, 'claude.exe'), 'MZ');
    await writeFile(join(npm, 'codex'), '#!/bin/sh\n'); // the extension-less sh shim npm also writes: never picked
    await writeFile(join(npm, 'codex.cmd'), NODE_SHIM('node_modules\\@openai\\codex\\bin\\codex.js'));
    await writeFile(join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '');
    await writeFile(join(npm, 'tool.bat'), '@echo off\r\necho %*\r\n');
    const env = { Path: `.;${a};"${npm}"`, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    const o = { platform: 'win32' as const, env, execPath: '/pinned/node.exe' };

    expect(await resolveCommand('claude', ['--version'], o)).toEqual({ file: join(a, 'claude.exe'), args: ['--version'], via: 'direct' });
    expect(await resolveCommand('codex', ['app-server'], o)).toEqual({
      file: '/pinned/node.exe',
      args: [join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'app-server'],
      via: 'node-shim',
    });
    // Any other .bat: the absolute cmd.exe (ComSpec only when absolute and named cmd.exe), every argument quoted.
    expect(await resolveCommand('tool', ['a b', 'c'], o)).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', `""${join(npm, 'tool.bat')}" "a b" "c""`],
      via: 'cmd',
    });
    expect(isCmdLine('C:\\Windows\\system32\\cmd.exe', ['/d', '/s', '/c', '"x"'])).toBe(true);
    // SystemRoot wins over ComSpec; a bare or foreign ComSpec is never used; unsafe arguments are refused.
    expect((await resolveCommand('tool', [], { ...o, env: { ...env, SystemRoot: 'D:\\Win', ComSpec: 'C:\\evil\\cmd.exe' } }))?.file).toBe('D:\\Win\\System32\\cmd.exe');
    for (const bad of [{ ComSpec: 'cmd.exe' }, { ComSpec: 'C:\\evil\\payload.exe' }, { SystemRoot: 'Windows' }, {}]) {
      await expect(resolveCommand('tool', [], { ...o, env: { Path: env.Path, ...bad } })).rejects.toBeInstanceOf(UnsafeCommandError);
    }
    for (const arg of ['%PATH%', 'x" & calc', 'a!b', 'a^b', 'a\nb']) {
      await expect(resolveCommand('tool', [arg], o)).rejects.toThrow(/cannot be passed safely/);
    }
    expect(systemCmd({ SystemRoot: 'C:\\Windows', ComSpec: 'C:\\evil\\cmd.exe' })).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(cmdLine(['a', 'b c'])).toBe('"a" "b c"');
    expect(await resolveCommand('nothing-here', [], o)).toBeNull();
    // Never an extensionless file, never the current directory (`.` is skipped), relative paths refused.
    expect(await findCommand('codex', { ...o, env: { ...env, PATHEXT: '.EXE' } })).toBeNull();
    expect(await findCommand('bin a\\claude', o)).toBeNull();
    expect(await findCommand(join(a, 'claude'), o)).toBe(join(a, 'claude.exe'));
  });

  it('on win32 a shim pointing outside its folder is not a shim (runs through cmd.exe instead)', async () => {
    const d = await tmp();
    await mkdir(join(d, 'up'), { recursive: true });
    await writeFile(join(d, 'evil.js'), '');
    await writeFile(join(d, 'up', 'x.cmd'), NODE_SHIM('..\\evil.js'));
    const r = await resolveCommand('x', [], { platform: 'win32', env: { PATH: join(d, 'up'), SystemRoot: 'C:\\Windows' }, execPath: '/n/node.exe' });
    expect(r?.via).toBe('cmd');
    expect(parseNpmCmdShim(NODE_SHIM('..\\evil.js'))).toBeNull();
  });

  it('on win32 an npm shim for an .exe resolves to the exe; a shim next to node.exe uses that node', async () => {
    const npm = await tmp();
    await mkdir(join(npm, 'node_modules', 'c', 'bin'), { recursive: true });
    await writeFile(join(npm, 'node_modules', 'c', 'bin', 'claude.exe'), 'MZ');
    await writeFile(join(npm, 'claude.cmd'), EXE_SHIM('node_modules\\c\\bin\\claude.exe'));
    await writeFile(join(npm, 'node_modules', 'c', 'bin', 'x.js'), '');
    await writeFile(join(npm, 'x.cmd'), NODE_SHIM('node_modules\\c\\bin\\x.js'));
    await writeFile(join(npm, 'node.exe'), 'MZ');
    const o = { platform: 'win32' as const, env: { PATH: npm }, execPath: '/other/node.exe' };
    expect(await resolveCommand('claude', [], o)).toEqual({ file: join(npm, 'node_modules', 'c', 'bin', 'claude.exe'), args: [], via: 'direct' });
    expect((await resolveCommand('x', [], o))?.file).toBe(join(npm, 'node.exe'));
  });

  // POSIX PATH (colon-separated) and execute bits: not meaningful with Windows paths.
  it.skipIf(process.platform === 'win32')('on POSIX finds an executable on PATH and skips non-executable files', async () => {
    const d = await tmp();
    await writeFile(join(d, 'tool'), '#!/bin/sh\n');
    await writeFile(join(d, 'plain'), '');
    await chmod(join(d, 'tool'), 0o755);
    await chmod(join(d, 'plain'), 0o644);
    const o = { platform: 'linux' as const, env: { PATH: `/nonexistent:${d}` } };
    expect(await resolveCommand('tool', ['x'], o)).toEqual({ file: join(d, 'tool'), args: ['x'], via: 'direct' });
    expect(await resolveCommand('plain', [], o)).toBeNull();
    expect(await resolveCommand('missing', [], o)).toBeNull();
  });

  describe('systemTool', () => {
    const win = { platform: 'win32' as const };
    it('maps system tools to absolute System32 paths on Windows', () => {
      const env = { SystemRoot: 'D:\\Win' };
      expect(systemTool('icacls', { ...win, env })).toBe('D:\\Win\\System32\\icacls.exe');
      expect(systemTool('schtasks', { ...win, env })).toBe('D:\\Win\\System32\\schtasks.exe');
      expect(systemTool('reg', { ...win, env })).toBe('D:\\Win\\System32\\reg.exe');
      expect(systemTool('taskkill', { ...win, env })).toBe('D:\\Win\\System32\\taskkill.exe');
      expect(systemTool('rundll32', { ...win, env })).toBe('D:\\Win\\System32\\rundll32.exe');
      expect(systemTool('powershell', { ...win, env })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      // windir when SystemRoot is unset (case-insensitive names); C:\Windows when neither is usable.
      expect(systemTool('reg', { ...win, env: { WINDIR: 'E:\\W' } })).toBe('E:\\W\\System32\\reg.exe');
      expect(systemTool('reg', { ...win, env: {} })).toBe('C:\\Windows\\System32\\reg.exe');
      expect(systemTool('reg', { ...win, env: { SystemRoot: 'relative' } })).toBe('C:\\Windows\\System32\\reg.exe');
    });
    it('leaves names alone elsewhere', () => {
      expect(systemTool('icacls', { platform: 'linux' })).toBe('icacls');
      expect(isSystemTool('Schtasks.exe')).toBe(true);
      expect(isSystemTool('claude')).toBe(false);
    });
    it('safeExecFile never hands a bare name to Windows', async () => {
      const env = { SystemRoot: 'C:\\Windows', Path: '' };
      expect(await safeExecFile('icacls', ['x'], { ...win, env })).toEqual({ file: 'C:\\Windows\\System32\\icacls.exe', args: ['x'] });
      expect(await safeExecFile('powershell.exe', [], { ...win, env })).toEqual({ file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: [] });
      // Not a system tool and not on PATH: null (never the current directory).
      expect(await safeExecFile('not-a-tool', [], { ...win, env })).toBeNull();
      // POSIX and paths pass through.
      expect(await safeExecFile('icacls', ['a'], { platform: 'darwin' })).toEqual({ file: 'icacls', args: ['a'] });
      expect(await safeExecFile('C:\\x\\y.exe', [], { ...win, env })).toEqual({ file: 'C:\\x\\y.exe', args: [] });
    });
  });
});
