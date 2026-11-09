import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCommand as sharedResolveCommand } from '@uncage/protocol/node';
import { execTarget, openUrlCommand, resolveCommand, selfUpgradeCommand } from './exe.js';

const cleanups: string[] = [];
afterEach(async () => {
  for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'uncage exe '));
  cleanups.push(d);
  return d;
}

describe('resolveCommand', () => {
  it('is the shared implementation (@uncage/protocol/node, tested there on every OS)', () => {
    expect(resolveCommand).toBe(sharedResolveCommand);
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

  it.skipIf(process.platform === 'win32')('on POSIX prefers the npm beside the running node', async () => {
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
    const [file, args] = openUrlCommand('https://x.test/d?c=1', 'win32');
    // Absolute (never looked up in the current directory).
    expect(file).toMatch(/^[A-Za-z]:\\.*\\System32\\rundll32\.exe$/i);
    expect(args).toEqual(['url.dll,FileProtocolHandler', 'https://x.test/d?c=1']);
  });
});

describe('execTarget', () => {
  it('maps Windows system tools to System32 and refuses unknown bare names', async () => {
    const win = { platform: 'win32' as const, env: { SystemRoot: 'C:\\Windows', Path: '' } };
    expect(await execTarget('icacls', ['f'], win)).toEqual({ file: 'C:\\Windows\\System32\\icacls.exe', args: ['f'] });
    expect(await execTarget('schtasks', ['/query'], win)).toEqual({ file: 'C:\\Windows\\System32\\schtasks.exe', args: ['/query'] });
    expect((await execTarget('powershell.exe', [], win)).file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    await expect(execTarget('git', [], win)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await execTarget('icacls', ['f'], { platform: 'linux' })).toEqual({ file: 'icacls', args: ['f'] });
  });
});
