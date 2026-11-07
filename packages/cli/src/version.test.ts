import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_VERSION, versionOutput } from './version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

describe('uncage --version', () => {
  it('is the package version', () => {
    expect(CLI_VERSION).toBe(pkg.version);
  });

  it('answers --version, -v and version, and nothing else', () => {
    for (const flag of ['--version', '-v', 'version']) expect(versionOutput(flag)).toBe(pkg.version);
    for (const other of [undefined, 'serve', '--help', '-V']) expect(versionOutput(other)).toBeNull();
  });
});
