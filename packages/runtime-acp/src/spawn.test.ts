import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UnsafeCommandError } from '@uncage/protocol/node';
import { fakeAcpPath } from '@uncage/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { acpSpawnArgv, startAcpProcess } from './process.js';

// How ACP agents are started on every OS (CI runs this file on ubuntu, macos and windows). Windows
// goes through `resolveCommand` (@uncage/protocol/node), the same code the agent uses for claude /
// codex: npm .cmd shims become node + JS, other .cmd/.bat run through the absolute cmd.exe.

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'uncage acp spawn '));
  dirs.push(d);
  return d;
}

/** The shim npm (cmd-shim 6) writes for a JS bin. */
const NODE_SHIM = (rel: string) =>
  `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n` +
  `IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n` +
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r\n`;

/** A JS agent that records its argv, then runs the fake ACP agent in the same process. */
async function recordingAgent(dir: string): Promise<{ script: string; argvFile: string }> {
  const argvFile = join(dir, 'argv.json');
  const script = join(dir, 'node_modules', 'fake-agent', 'agent.mjs');
  await mkdir(join(dir, 'node_modules', 'fake-agent'), { recursive: true });
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nawait import(${JSON.stringify(pathToFileURL(fakeAcpPath).href)});\n`,
  );
  return { script, argvFile };
}

const handlers = { onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }) };

async function startAndRecord(command: string[], env: NodeJS.ProcessEnv, argvFile: string): Promise<string[]> {
  const p = await startAcpProcess({ command, env, handlers, initTimeoutMs: 20_000 });
  try {
    expect(p.init.protocolVersion).toBe(1);
    return JSON.parse(await readFile(argvFile, 'utf8')) as string[];
  } finally {
    p.kill();
    await p.exited;
  }
}

describe('acpSpawnArgv (Windows rules, platform injected: runs on every OS)', () => {
  it('npm shim → node + JS; .exe direct; other .bat → absolute cmd.exe, exact quoting; not found → ENOENT; unsafe → refused', async () => {
    const dir = await tmp();
    await mkdir(join(dir, 'node_modules', 'g', 'bin'), { recursive: true });
    await writeFile(join(dir, 'gem.cmd'), NODE_SHIM('node_modules\\g\\bin\\gem.js'));
    await writeFile(join(dir, 'node_modules', 'g', 'bin', 'gem.js'), '');
    await writeFile(join(dir, 'tool.bat'), '@echo off\r\n');
    await writeFile(join(dir, 'bin.exe'), 'MZ');
    await writeFile(join(dir, 'plain'), '');
    const env = { Path: `.;${dir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\Windows' };

    const shim = await acpSpawnArgv(['gem', '--acp'], env, 'win32');
    expect(shim).toEqual({ file: process.execPath, args: [join(dir, 'node_modules', 'g', 'bin', 'gem.js'), '--acp'], verbatim: false });
    expect(await acpSpawnArgv(['bin', 'acp'], env, 'win32')).toEqual({ file: join(dir, 'bin.exe'), args: ['acp'], verbatim: false });
    expect(await acpSpawnArgv(['tool', 'a b', 'c&d'], env, 'win32')).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', `""${join(dir, 'tool.bat')}" "a b" "c&d""`],
      verbatim: true,
    });
    // Never the current directory (the `.` PATH entry is skipped), never an extensionless file.
    await expect(acpSpawnArgv(['plain'], env, 'win32')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(acpSpawnArgv(['missing', 'acp'], env, 'win32')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(acpSpawnArgv(['tool', '%PATH%'], env, 'win32')).rejects.toBeInstanceOf(UnsafeCommandError);
    await expect(acpSpawnArgv(['tool'], { Path: dir }, 'win32')).rejects.toThrow(/cmd\.exe was not found/);
    // Elsewhere: unchanged (the spawn searches env.PATH itself).
    expect(await acpSpawnArgv(['gem', '--acp'], env, 'linux')).toEqual({ file: 'gem', args: ['--acp'], verbatim: false });
  });
});

describe('startAcpProcess passes the exact argv (real spawn)', () => {
  it('an absolute node + script', async () => {
    const dir = await tmp();
    const { script, argvFile } = await recordingAgent(dir);
    const argv = ['--acp', 'a b', 'c&d', 'é'];
    expect(await startAndRecord([process.execPath, script, ...argv], process.env, argvFile)).toEqual(argv);
  });

  describe.runIf(process.platform === 'win32')('Windows', () => {
    const withPath = (dir: string): NodeJS.ProcessEnv => {
      const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path';
      return { ...process.env, [key]: `${dir};${process.env[key] ?? ''}` };
    };

    it('an npm .cmd shim on PATH runs as node + JS (no cmd.exe, no shell)', async () => {
      const dir = await tmp();
      const { argvFile } = await recordingAgent(dir);
      await writeFile(join(dir, 'fake-acp.cmd'), NODE_SHIM('node_modules\\fake-agent\\agent.mjs'));
      const env = withPath(dir);
      expect((await acpSpawnArgv(['fake-acp'], env)).file).toBe(process.execPath);
      expect(await startAndRecord(['fake-acp', '--acp', 'a b', 'c&d'], env, argvFile)).toEqual(['--acp', 'a b', 'c&d']);
    });

    it('another .bat on PATH runs through the absolute cmd.exe with every argument intact', async () => {
      const dir = await tmp();
      const { script, argvFile } = await recordingAgent(dir);
      await writeFile(join(dir, 'my-agent.bat'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
      const env = withPath(dir);
      const r = await acpSpawnArgv(['my-agent'], env);
      expect(r.verbatim).toBe(true);
      expect(r.file.toLowerCase()).toMatch(/^[a-z]:\\.*\\system32\\cmd\.exe$/);
      expect(await startAndRecord(['my-agent', '--acp', 'a b', 'c&d', '(x)'], env, argvFile)).toEqual(['--acp', 'a b', 'c&d', '(x)']);
    });

    it('a command not on PATH is ENOENT (reported as not installed), never looked up in the current directory', async () => {
      const dir = await tmp();
      await writeFile(join(dir, 'here.bat'), '@echo off\r\n');
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        await expect(startAcpProcess({ command: ['here'], env: process.env, handlers, initTimeoutMs: 5_000 })).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        process.chdir(cwd);
      }
    });
  });
});
