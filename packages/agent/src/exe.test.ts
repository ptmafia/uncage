import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openUrlCommand, parseNpmCmdShim, resolveCommand, selfUpgradeCommand } from './exe.js';

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
    const env = { Path: `${a};"${npm}"`, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    const o = { platform: 'win32' as const, env, execPath: '/pinned/node.exe' };

    expect(await resolveCommand('claude', ['--version'], o)).toEqual({ file: join(a, 'claude.exe'), args: ['--version'], via: 'direct' });
    expect(await resolveCommand('codex', ['app-server'], o)).toEqual({
      file: '/pinned/node.exe',
      args: [join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'app-server'],
      via: 'node-shim',
    });
    expect(await resolveCommand('tool', ['a b', 'c'], o)).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', `""${join(npm, 'tool.bat')}" "a b" c"`],
      via: 'cmd',
    });
    expect(await resolveCommand('nothing-here', [], o)).toBeNull();
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

  it('on POSIX finds an executable on PATH and skips non-executable files', async () => {
    const d = await tmp();
    await writeFile(join(d, 'tool'), '#!/bin/sh\n');
    await writeFile(join(d, 'plain'), '');
    await chmod(join(d, 'tool'), 0o755);
    await chmod(join(d, 'plain'), 0o644);
    const o = { platform: 'linux' as const, env: { PATH: `/nonexistent:${d}` } };
    expect(await resolveCommand('tool', ['x'], o)).toEqual({ file: join(d, 'tool'), args: ['x'], via: 'direct' });
    if (process.platform !== 'win32') expect(await resolveCommand('plain', [], o)).toBeNull();
    expect(await resolveCommand('missing', [], o)).toBeNull();
  });
});

describe('selfUpgradeCommand', () => {
  it('on win32 runs npm through node npm-cli.js, not npm.cmd', async () => {
    const nodeDir = await tmp();
    await mkdir(join(nodeDir, 'node_modules', 'npm', 'bin'), { recursive: true });
    await writeFile(join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    await writeFile(join(nodeDir, 'node.exe'), 'MZ');
    await writeFile(join(nodeDir, 'npm.cmd'), '@echo off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n');
    const execPath = join(nodeDir, 'node.exe');
    expect(await selfUpgradeCommand({ platform: 'win32', env: { PATH: nodeDir }, execPath })).toEqual([
      execPath,
      [join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'i', '-g', '@uncage/cli@latest'],
    ]);

    // The pinned Node has no npm beside it (e.g. a copied binary): npm-cli.js beside the npm.cmd on PATH.
    const elsewhere = await tmp();
    expect(await selfUpgradeCommand({ platform: 'win32', env: { PATH: nodeDir }, execPath: join(elsewhere, 'node.exe') })).toEqual([
      join(elsewhere, 'node.exe'),
      [join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'i', '-g', '@uncage/cli@latest'],
    ]);
  });

  it('on POSIX prefers the npm beside the running node', async () => {
    const d = await tmp();
    await writeFile(join(d, 'npm'), '#!/bin/sh\n');
    await chmod(join(d, 'npm'), 0o755);
    expect(await selfUpgradeCommand({ platform: 'linux', env: { PATH: '' }, execPath: join(d, 'node') })).toEqual([
      join(d, 'npm'),
      ['i', '-g', '@uncage/cli@latest'],
    ]);
    expect(await selfUpgradeCommand({ platform: 'linux', env: { PATH: '' }, execPath: '/nowhere/node' })).toEqual(['npm', ['i', '-g', '@uncage/cli@latest']]);
  });
});

describe('openUrlCommand', () => {
  it('uses open / xdg-open / rundll32', () => {
    expect(openUrlCommand('https://x.test/d?c=1', 'darwin')).toEqual(['open', ['https://x.test/d?c=1']]);
    expect(openUrlCommand('https://x.test/d?c=1', 'linux')).toEqual(['xdg-open', ['https://x.test/d?c=1']]);
    expect(openUrlCommand('https://x.test/d?c=1', 'win32')).toEqual(['rundll32', ['url.dll,FileProtocolHandler', 'https://x.test/d?c=1']]);
  });
});
