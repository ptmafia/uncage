import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_VERSION, versionOutput } from './version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

describe('uncage --version', () => {
  it('is the package version', () => {
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it('answers --version, -v and version, and nothing else', () => {
    for (const flag of ['--version', '-v', 'version']) expect(versionOutput(flag)?.split('\n')[0]).toBe(pkg.version);
    for (const other of [undefined, 'serve', '--help', '-V']) expect(versionOutput(other)).toBeNull();
  });

  it('prints the version, then the Node actually in use', () => {
    expect(versionOutput('--version', { version: 'v22.23.4', execPath: '/opt/node/bin/node' })).toBe(`${pkg.version}\nnode v22.23.4 (/opt/node/bin/node)`);
    const [first, second] = versionOutput('--version')!.split('\n');
    expect(first).toBe(pkg.version);
    expect(second).toBe(`node ${process.version} (${process.execPath})`);
    // The first x.y.z on the output is the CLI's, as the installers read it.
    expect(/(\d+)\.(\d+)\.(\d+)/.exec(versionOutput('--version')!)?.[0]).toBe(pkg.version);
    expect(execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).trim()).toBe(process.version);
  });
});
